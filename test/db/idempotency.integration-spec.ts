import { createHash, randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { createMember, createTenant } from '../harness/fixtures';

// The idempotency record as the database holds it (0.7.7): in raw SQL, as
// the runtime role, on two tenants. Each CHECK refuses its counter-example,
// a row in each state keeps them all, and a key's namespace is its tenant's
// and its member's. The service and its routes are proved through HTTP
// (test/platform/idempotency.e2e-spec.ts). Values are synthetic.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const sha256 = (text: string) => createHash('sha256').update(text).digest();

describe('the idempotency record, as the database holds it', () => {
  let app: Client;
  let tenants: Tenant[];
  let members: User[];

  beforeAll(async () => {
    tenants = [await createTenant(), await createTenant()];
    members = [
      await createMember(tenants[0], 'ADMIN'),
      await createMember(tenants[1], 'ADMIN'),
    ];
    const { connectionString, options } = databaseConnectionOf(
      inject('databaseUrl'),
    );
    app = new Client({ connectionString, options });
    await app.connect();
  });

  afterAll(async () => {
    await app?.end();
  });

  /** Records written straight, as `member`'s tenant, rolled back: or why they were refused. */
  async function insert(
    member: User,
    ...rows: Record<string, unknown>[]
  ): Promise<'written' | { code: string; constraint?: string }> {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [
        member.tenantId,
      ]);
      for (const values of rows) {
        const row = {
          tenant_id: member.tenantId,
          actor_user_id: member.id,
          method: 'POST',
          canonical_path: '/api/v1/players',
          key_hash: sha256(`key-${randomUUID()}`),
          request_hash: sha256('{}'),
          lease_until: new Date(Date.now() + 30_000),
          expires_at: new Date(Date.now() + 24 * 3_600_000),
          ...values,
        };
        const columns = Object.keys(row);
        await app.query(
          `INSERT INTO idempotency_records (id, ${columns.join(', ')})
           VALUES (uuidv7(), ${columns.map((_, n) => `$${n + 1}`).join(', ')})`,
          Object.values(row),
        );
      }
      return 'written';
    } catch (error) {
      const { code, constraint } = error as DatabaseError;
      return { code: code ?? '', constraint };
    } finally {
      await app.query('ROLLBACK');
    }
  }

  it('an_idempotency_record_holds_only_what_its_checks_allow', async () => {
    const [member] = members;
    const done = new Date();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['idempotency_records_method_check', { method: 'GET' }],
      [
        'idempotency_records_canonical_path_check',
        { canonical_path: 'players' },
      ],
      [
        'idempotency_records_canonical_path_check',
        { canonical_path: '/api/v1/players/two words' },
      ],
      ['idempotency_records_key_hash_check', { key_hash: Buffer.alloc(16) }],
      [
        'idempotency_records_request_hash_check',
        { request_hash: Buffer.alloc(33) },
      ],
      [
        'idempotency_records_fencing_generation_check',
        { fencing_generation: 0 },
      ],
      // A lease exactly while IN_PROGRESS.
      ['idempotency_records_lease_check', { lease_until: null }],
      [
        'idempotency_records_lease_check',
        { state: 'SUCCEEDED', completed_at: done },
      ],
      // A completion time exactly once finished; a code exactly when refused;
      // only a success names what it made.
      ['idempotency_records_outcome_check', { completed_at: done }],
      [
        'idempotency_records_outcome_check',
        { state: 'SUCCEEDED', lease_until: null },
      ],
      [
        'idempotency_records_outcome_check',
        { state: 'REJECTED', lease_until: null, completed_at: done },
      ],
      [
        'idempotency_records_outcome_check',
        {
          state: 'SUCCEEDED',
          lease_until: null,
          completed_at: done,
          outcome_code: 'CONFLICT',
        },
      ],
      [
        'idempotency_records_outcome_check',
        {
          state: 'REJECTED',
          lease_until: null,
          completed_at: done,
          outcome_code: 'CONFLICT',
          result_ref: randomUUID(),
        },
      ],
      ['idempotency_records_outcome_check', { result_ref: randomUUID() }],
      [
        'idempotency_records_outcome_code_check',
        {
          state: 'REJECTED',
          lease_until: null,
          completed_at: done,
          outcome_code: 'conflict',
        },
      ],
      [
        'idempotency_records_expiry_check',
        { expires_at: new Date(Date.now() - 1_000) },
      ],
    ];
    for (const [constraint, values] of cases) {
      expect([constraint, values, await insert(member, values)]).toEqual([
        constraint,
        values,
        { code: CHECK_VIOLATION, constraint },
      ]);
    }

    // A row in each state keeps them all.
    for (const values of [
      {},
      {
        fencing_generation: 3,
        method: 'PATCH',
        canonical_path: '/api/v1/players/%C3%A9',
      },
      {
        state: 'SUCCEEDED',
        lease_until: null,
        completed_at: done,
        result_ref: randomUUID(),
      },
      { state: 'SUCCEEDED', lease_until: null, completed_at: done },
      {
        state: 'REJECTED',
        lease_until: null,
        completed_at: done,
        outcome_code: 'REVISION_MISMATCH',
      },
    ]) {
      expect([values, await insert(member, values)]).toEqual([
        values,
        'written',
      ]);
    }
  });

  it('a_key_is_unique_in_its_members_namespace_only', async () => {
    const [member, other] = members;
    const keyHash = sha256(`key-${randomUUID()}`);
    // The same key twice for one member, method and path: refused.
    expect(
      await insert(member, { key_hash: keyHash }, { key_hash: keyHash }),
    ).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'idempotency_records_namespace_key',
    });
    // On another path or method, it is another key.
    expect(
      await insert(
        member,
        { key_hash: keyHash },
        { key_hash: keyHash, canonical_path: '/api/v1/contracts' },
        { key_hash: keyHash, method: 'PUT' },
      ),
    ).toBe('written');
    // A record names a member of its own tenant only.
    expect(await insert(member, { actor_user_id: other.id })).toEqual({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'idempotency_records_actor_user_id_tenant_id_fkey',
    });
    // Another tenant's member, the same key: their own namespace.
    expect(await insert(other, { key_hash: keyHash })).toBe('written');
  });
});
