import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { createMember, createTenant } from '../harness/fixtures';

// Invitations (0.5.10), in raw SQL as the runtime role, on two tenants: what
// the database holds an invitation to whatever the code does. The use cases
// and the acceptance are test/users/invitations.e2e-spec.ts's. Every address,
// issuer and subject is synthetic.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const INSUFFICIENT_PRIVILEGE = '42501';
const ISSUER = 'https://idp.sadara.test/realms/sadara';
const DAY_MS = 24 * 3_600_000;

/** What an invitation's token is stored as: its SHA-256 digest, 32 bytes. */
const digest = (token: string) => createHash('sha256').update(token).digest();

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

type Outcome =
  | { rowCount: number; rows: Record<string, unknown>[] }
  | { code?: string; constraint?: string; message: string };

describe('invitations in the database', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;
  let ownerA: User;
  let ownerB: User;

  /** One statement in its own transaction, as `tenant` (null: none named). */
  async function as(
    tenant: Tenant | null,
    sql: string,
    params: unknown[] = [],
  ): Promise<Outcome> {
    await app.query('BEGIN');
    try {
      if (tenant) {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant.id,
        ]);
      }
      const { rowCount, rows } = await app.query<Record<string, unknown>>(
        sql,
        params,
      );
      await app.query('COMMIT');
      return { rowCount: rowCount ?? 0, rows };
    } catch (error) {
      await app.query('ROLLBACK');
      const { code, constraint, message } = error as DatabaseError;
      return { code, constraint, message };
    }
  }

  const refusedBy = (code: string, constraint: string) =>
    expect.objectContaining({ code, constraint }) as unknown;

  const address = () => `invitee-${randomBytes(4).toString('hex')}@agency.test`;

  /** An invitation row in `tenant` from `inviter`, with `overrides` on the defaults. */
  function invite(
    tenant: Tenant,
    inviter: User,
    overrides: Record<string, unknown> = {},
  ) {
    const email = (overrides.email as string | undefined) ?? address();
    const row: Record<string, unknown> = {
      id: randomUUID(),
      tenant_id: tenant.id,
      email,
      normalized_email: email.toLowerCase(),
      role: 'SCOUT',
      locale: 'ar',
      invited_by_id: inviter.id,
      expires_at: new Date(Date.now() + 7 * DAY_MS),
      updated_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(row);
    return as(
      tenant,
      `INSERT INTO invitations (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
  }

  /** A member of `tenant` linked to a new identity: whom an acceptance names. */
  async function linkedMember(
    tenant: Tenant,
  ): Promise<{ member: User; identity: string }> {
    const identity = randomUUID();
    expect(
      await as(
        null,
        'INSERT INTO identities (id, issuer, subject) VALUES ($1, $2, $3)',
        [identity, ISSUER, randomUUID()],
      ),
    ).toMatchObject({ rowCount: 1 });
    const member = await createMember(tenant, 'SCOUT');
    expect(
      await as(tenant, 'UPDATE users SET identity_id = $1 WHERE id = $2', [
        identity,
        member.id,
      ]),
    ).toMatchObject({ rowCount: 1 });
    return { member, identity };
  }

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
    [ownerA, ownerB] = [
      await createMember(a, 'OWNER'),
      await createMember(b, 'OWNER'),
    ];
  });

  afterAll(async () => {
    await app?.end();
  });

  it('invitations_hold_their_rules_in_the_database', async () => {
    // A well-formed invitation is stored, in its own tenant only.
    expect(await invite(a, ownerA)).toMatchObject({ rowCount: 1 });
    expect(await invite(a, ownerB)).toEqual(
      refusedBy(
        FOREIGN_KEY_VIOLATION,
        'invitations_invited_by_id_tenant_id_fkey',
      ),
    );

    // Its address in users' normal form, or refused.
    expect(
      await invite(a, ownerA, {
        email: 'Invitee@Agency.test',
        normalized_email: 'Invitee@Agency.test',
      }),
    ).toEqual(refusedBy(CHECK_VIOLATION, 'invitations_normalized_email_check'));

    // A token is stored as its digest, issued at a time; the token as a link
    // carries it is not a digest's size. A digest names one invitation in
    // its tenant.
    const token = randomBytes(32).toString('base64url');
    const issued = { token_hash: digest(token), token_issued_at: new Date() };
    expect(await invite(a, ownerA, issued)).toMatchObject({ rowCount: 1 });
    expect(
      await invite(a, ownerA, {
        token_hash: Buffer.from(token),
        token_issued_at: new Date(),
      }),
    ).toEqual(refusedBy(CHECK_VIOLATION, 'invitations_token_hash_check'));
    expect(
      await invite(a, ownerA, {
        token_hash: digest(randomUUID()),
      }),
    ).toEqual(refusedBy(CHECK_VIOLATION, 'invitations_token_check'));
    expect(await invite(a, ownerA, issued)).toEqual(
      refusedBy(UNIQUE_VIOLATION, 'invitations_tenant_id_token_hash_key'),
    );

    // An acceptance names the member it made and that member's identity,
    // together, in the invitation's tenant.
    const accepted = await linkedMember(a);
    const elsewhere = await linkedMember(b);
    const acceptance = (
      member: { member: User; identity: string },
      at: Date | null = new Date(),
    ) => ({
      accepted_at: at,
      accepted_member_id: member.member.id,
      accepted_identity_id: member.identity,
    });
    expect(await invite(a, ownerA, acceptance(accepted))).toMatchObject({
      rowCount: 1,
    });
    expect(await invite(a, ownerA, acceptance(accepted, null))).toEqual(
      refusedBy(CHECK_VIOLATION, 'invitations_acceptance_check'),
    );
    expect(
      await invite(a, ownerA, {
        ...acceptance(accepted),
        accepted_identity_id: elsewhere.identity,
      }),
    ).toEqual(
      refusedBy(
        FOREIGN_KEY_VIOLATION,
        'invitations_accepted_member_id_tenant_id_accepted_identity_fkey',
      ),
    );
    expect(await invite(a, ownerA, acceptance(elsewhere))).toEqual(
      refusedBy(
        FOREIGN_KEY_VIOLATION,
        'invitations_accepted_member_id_tenant_id_accepted_identity_fkey',
      ),
    );

    // Accepted or revoked, never both; it expires after it is made; and no
    // invitation grants SUPER_ADMIN.
    expect(
      await invite(a, ownerA, {
        ...acceptance(accepted),
        revoked_at: new Date(),
      }),
    ).toEqual(refusedBy(CHECK_VIOLATION, 'invitations_closed_once_check'));
    expect(
      await invite(a, ownerA, { expires_at: new Date(Date.now() - DAY_MS) }),
    ).toEqual(refusedBy(CHECK_VIOLATION, 'invitations_expiry_check'));
    expect(await invite(a, ownerA, { role: 'SUPER_ADMIN' })).toEqual(
      refusedBy(CHECK_VIOLATION, 'invitations_role_check'),
    );

    // One open invitation per address in a tenant: a second is refused until
    // the first is closed; the same address may be invited by another tenant.
    const email = address();
    const first = await invite(a, ownerA, { email });
    expect(first).toMatchObject({ rowCount: 1 });
    expect(await invite(a, ownerA, { email })).toEqual(
      refusedBy(UNIQUE_VIOLATION, 'invitations_open_address_key'),
    );
    expect(await invite(b, ownerB, { email })).toMatchObject({ rowCount: 1 });
    if (!('rows' in first)) throw new Error(first.message);
    const id = first.rows[0].id as string;
    expect(
      await as(a, 'UPDATE invitations SET revoked_at = now() WHERE id = $1', [
        id,
      ]),
    ).toMatchObject({ rowCount: 1 });
    expect(await invite(a, ownerA, { email })).toMatchObject({ rowCount: 1 });

    // An invitation is closed, never removed: the runtime role cannot delete one.
    expect(
      await as(a, 'DELETE FROM invitations WHERE id = $1', [id]),
    ).toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });
});
