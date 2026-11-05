import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { createMember, createTenant } from '../harness/fixtures';

// Identities, memberships and sessions (0.5.3; DB-16), in raw SQL as the
// runtime role, on two tenants. An identity is global: the issuer and subject
// a provider gave a person. A User is that person's membership of one tenant.
// A session stores the digest of its token and what the ID token asserted,
// and no token of any kind. Every issuer, subject and address is synthetic.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const INSUFFICIENT_PRIVILEGE = '42501';
const ISSUER = 'https://idp.sadara.test/realms/sadara';

/** The digest the session cookie's token is stored as: SHA-256, 32 bytes. */
const digest = (token: Buffer) => createHash('sha256').update(token).digest();

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

type Outcome =
  | { rowCount: number; rows: Record<string, unknown>[] }
  | { code?: string; constraint?: string; message: string };

describe('identities, memberships and sessions', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;

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

  /** A new identity, added as the runtime role adds one: no tenant named. */
  async function newIdentity(subject = randomUUID()): Promise<string> {
    const id = randomUUID();
    const outcome = await as(
      null,
      'INSERT INTO identities (id, issuer, subject) VALUES ($1, $2, $3)',
      [id, ISSUER, subject],
    );
    expect(outcome).toMatchObject({ rowCount: 1 });
    return id;
  }

  const link = (member: User, identity: string, tenant: Tenant) =>
    as(tenant, 'UPDATE users SET identity_id = $1 WHERE id = $2', [
      identity,
      member.id,
    ]);

  /** A session row for `member` as `identity`, with `overrides` on the defaults. */
  function insertSession(
    tenant: Tenant,
    member: User,
    identity: string,
    overrides: Record<string, unknown> = {},
  ) {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      tenant_id: tenant.id,
      user_id: member.id,
      identity_id: identity,
      token_hash: digest(randomBytes(32)),
      issuer: ISSUER,
      subject: 'subject-of-the-identity',
      provider_sid: randomUUID(),
      acr: '1',
      amr: ['pwd'],
      auth_time: new Date(),
      idle_expires_at: new Date(Date.now() + 30 * 60_000),
      absolute_expires_at: new Date(Date.now() + 12 * 3_600_000),
      ...overrides,
    };
    const columns = Object.keys(row);
    return as(
      tenant,
      `INSERT INTO user_sessions (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
  });

  afterAll(async () => {
    await app?.end();
  });

  it('an_identity_links_to_at_most_one_membership_per_tenant', async () => {
    const person = await newIdentity();
    const [first, second] = [
      await createMember(a, 'COACH'),
      await createMember(a, 'SCOUT'),
    ];
    const elsewhere = await createMember(b, 'LEGAL');

    // One membership in a tenant; a second in the same tenant is refused.
    expect(await link(first, person, a)).toMatchObject({ rowCount: 1 });
    expect(await link(second, person, a)).toEqual(
      refusedBy(UNIQUE_VIOLATION, 'users_identity_id_tenant_id_key'),
    );
    // The same person is a member of another tenant too, each linked once.
    expect(await link(elsewhere, person, b)).toMatchObject({ rowCount: 1 });
    expect(
      await as(a, 'SELECT id FROM users WHERE identity_id = $1', [person]),
    ).toMatchObject({ rows: [{ id: first.id }] });

    // A membership names an identity that exists.
    expect(await link(second, randomUUID(), a)).toEqual(
      refusedBy(FOREIGN_KEY_VIOLATION, 'users_identity_id_fkey'),
    );

    // The issuer and subject name one identity; the runtime role adds
    // identities and never rewrites or removes one.
    const taken = randomUUID();
    await newIdentity(taken);
    expect(
      await as(
        null,
        'INSERT INTO identities (id, issuer, subject) VALUES ($1, $2, $3)',
        [randomUUID(), ISSUER, taken],
      ),
    ).toEqual(refusedBy(UNIQUE_VIOLATION, 'identities_issuer_subject_key'));
    for (const sql of [
      "UPDATE identities SET subject = 'someone-else' WHERE id = $1",
      'DELETE FROM identities WHERE id = $1',
    ]) {
      expect([sql, await as(null, sql, [person])]).toEqual([
        sql,
        expect.objectContaining({
          code: INSUFFICIENT_PRIVILEGE,
          message: expect.stringMatching(/^permission denied/) as string,
        }),
      ]);
    }
    for (const [column, value] of [
      ['issuer', ''],
      ['subject', ''],
    ]) {
      expect(
        await as(
          null,
          'INSERT INTO identities (id, issuer, subject) VALUES ($1, $2, $3)',
          [
            randomUUID(),
            column === 'issuer' ? value : ISSUER,
            column === 'subject' ? value : randomUUID(),
          ],
        ),
      ).toEqual(refusedBy(CHECK_VIOLATION, `identities_${column}_check`));
    }

    // A session is the member's, in its tenant, as the identity it is linked
    // to: neither another identity nor another tenant's member.
    const other = await newIdentity();
    expect(await insertSession(a, first, person)).toMatchObject({
      rowCount: 1,
    });
    expect(await insertSession(a, first, other)).toEqual(
      refusedBy(
        FOREIGN_KEY_VIOLATION,
        'user_sessions_user_id_tenant_id_identity_id_fkey',
      ),
    );
    expect(await insertSession(a, elsewhere, person)).toEqual(
      refusedBy(
        FOREIGN_KEY_VIOLATION,
        'user_sessions_user_id_tenant_id_identity_id_fkey',
      ),
    );
    // An unlinked member has no identity a session could name.
    expect(await insertSession(a, second, other)).toEqual(
      refusedBy(
        FOREIGN_KEY_VIOLATION,
        'user_sessions_user_id_tenant_id_identity_id_fkey',
      ),
    );
  });

  it('sessions_store_only_token_hashes', async () => {
    const person = await newIdentity();
    const member = await createMember(a, 'COACH');
    expect(await link(member, person, a)).toMatchObject({ rowCount: 1 });

    // What a session row holds, column by column: the digest of its token is
    // the only token material; no CSRF token, no provider token.
    const { rows: columns } = await app.query<{
      column: string;
      type: string;
      nullable: boolean;
    }>(
      `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable
         FROM pg_attribute a
        WHERE a.attrelid = 'user_sessions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
    );
    expect(columns).toEqual([
      { column: 'id', type: 'uuid', nullable: false },
      { column: 'tenant_id', type: 'uuid', nullable: false },
      { column: 'user_id', type: 'uuid', nullable: false },
      { column: 'identity_id', type: 'uuid', nullable: false },
      { column: 'token_hash', type: 'bytea', nullable: false },
      { column: 'issuer', type: 'character varying(500)', nullable: false },
      { column: 'subject', type: 'character varying(255)', nullable: false },
      {
        column: 'provider_sid',
        type: 'character varying(255)',
        nullable: true,
      },
      { column: 'acr', type: 'character varying(255)', nullable: true },
      { column: 'amr', type: 'character varying(64)[]', nullable: true },
      {
        column: 'auth_time',
        type: 'timestamp(3) with time zone',
        nullable: false,
      },
      {
        column: 'created_at',
        type: 'timestamp(3) with time zone',
        nullable: false,
      },
      {
        column: 'last_seen_at',
        type: 'timestamp(3) with time zone',
        nullable: false,
      },
      {
        column: 'idle_expires_at',
        type: 'timestamp(3) with time zone',
        nullable: false,
      },
      {
        column: 'absolute_expires_at',
        type: 'timestamp(3) with time zone',
        nullable: false,
      },
      {
        column: 'revoked_at',
        type: 'timestamp(3) with time zone',
        nullable: true,
      },
      { column: 'revoke_reason', type: 'session_revocation', nullable: true },
      { column: 'revision', type: 'integer', nullable: false },
    ]);

    // A digest is stored; the token itself, as the cookie carries it, is not
    // a digest's size and is refused.
    const token = randomBytes(32);
    const stored = digest(token);
    expect(
      await insertSession(a, member, person, { token_hash: stored }),
    ).toMatchObject({ rowCount: 1 });
    expect(
      await insertSession(a, member, person, {
        token_hash: Buffer.from(token.toString('base64url')),
      }),
    ).toEqual(refusedBy(CHECK_VIOLATION, 'user_sessions_token_hash_check'));
    // A digest names one session in its tenant.
    expect(
      await insertSession(a, member, person, { token_hash: stored }),
    ).toEqual(
      refusedBy(UNIQUE_VIOLATION, 'user_sessions_tenant_id_token_hash_key'),
    );
    // The session is found by the digest, never by the token.
    expect(
      await as(a, 'SELECT user_id FROM user_sessions WHERE token_hash = $1', [
        digest(token),
      ]),
    ).toMatchObject({ rows: [{ user_id: member.id }] });
    // And only in its tenant: another tenant sees no session of A's.
    expect(
      await as(b, 'SELECT count(*)::int AS n FROM user_sessions'),
    ).toMatchObject({ rows: [{ n: 0 }] });

    // Idle expiry never passes the absolute; a revocation has its reason, and
    // a reason its revocation; a revision counts from one.
    const now = Date.now();
    const refusals: Array<[Record<string, unknown>, string]> = [
      [
        {
          idle_expires_at: new Date(now + 13 * 3_600_000),
          absolute_expires_at: new Date(now + 12 * 3_600_000),
        },
        'user_sessions_times_check',
      ],
      [{ revoked_at: new Date() }, 'user_sessions_revocation_check'],
      [{ revoke_reason: 'SIGN_OUT' }, 'user_sessions_revocation_check'],
      [{ revision: 0 }, 'user_sessions_revision_check'],
    ];
    for (const [overrides, constraint] of refusals) {
      expect([
        constraint,
        await insertSession(a, member, person, overrides),
      ]).toEqual([constraint, refusedBy(CHECK_VIOLATION, constraint)]);
    }
    expect(
      await insertSession(a, member, person, {
        revoked_at: new Date(),
        revoke_reason: 'SIGN_OUT',
      }),
    ).toMatchObject({ rowCount: 1 });
  });
});
