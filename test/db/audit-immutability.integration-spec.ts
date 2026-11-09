import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AUDIT_SCHEMA_VERSION,
  auditedChangeOf,
} from '../../src/infrastructure/audit/audit-actor';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  asTenant,
  createMember,
  createTenant,
  memberContext,
  testContext,
} from '../harness/fixtures';
import {
  createIsolatedSchema,
  type IsolatedSchema,
  prismaFor,
} from '../harness/db';

// Audit evidence is append-only in the database (0.7.1; SR-AUD-005,
// SR-DB-009, BR-RULE-05). The runtime role may insert and read its tenant's
// rows and nothing more; triggers refuse UPDATE, DELETE and TRUNCATE for every
// role, the owner included. Two tenants, PostgreSQL 18, as the runtime role
// and as the owner. Under forced row-level security the owner reads but
// cannot write a row, so an UPDATE or DELETE of its would change nothing
// without an error; the owner's attempts lift FORCE first, as a data
// migration does, so that the trigger is what refuses.

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Outcome =
  { rowCount: number } | { code?: string; message: string; hint?: string };

const refused = (message: RegExp) =>
  expect.objectContaining({
    code: INSUFFICIENT_PRIVILEGE,
    message: expect.stringMatching(message) as unknown,
  }) as unknown;
const DENIED = /^permission denied for table audit_logs$/;
const APPEND_ONLY = (operation: string) =>
  new RegExp(
    `^evidence is append-only: ${operation} on audit_logs is refused$`,
  );

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

/**
 * One piece of work in its own transaction, rolled back whatever it did: as
 * `tenant` when one is named, and with FORCE lifted when `lift`, as a data
 * migration lifts it. What it wrote, or why it was refused.
 */
async function attempt(
  client: Client,
  sql: string,
  params: readonly unknown[] = [],
  { tenant, lift }: { tenant?: Tenant; lift?: boolean } = {},
): Promise<Outcome> {
  await client.query('BEGIN');
  try {
    if (tenant) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenant.id,
      ]);
    }
    if (lift) {
      await client.query('ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY');
    }
    const { rowCount } = await client.query(sql, [...params]);
    return { rowCount: rowCount ?? 0 };
  } catch (error) {
    const { code, message, hint } = error as DatabaseError;
    return { code, message, hint };
  } finally {
    await client.query('ROLLBACK');
  }
}

/** A row through the app's own writer: who acted, as `ctx` held it. */
function auditAs(ctx: AuthorizedTenantContext, action = 'test.probe') {
  return asTenant(ctx.tenantId, (tx) =>
    tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        ...auditedChangeOf(ctx),
        action,
        entityType: 'Player',
        entityId: randomUUID(),
        newValues: { probe: true },
      },
    }),
  );
}

describe('audit evidence is append-only', () => {
  let app: Client;
  let owner: Client;
  let a: Tenant;
  let b: Tenant;
  let memberA: User;
  /** One audit row of each tenant's. */
  let rowOf: Map<Tenant, string>;

  /** Every audit row of both tenants, in full, as the owner reads them. */
  async function evidence(): Promise<string> {
    const { rows } = await owner.query<{ digest: string }>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) AS digest
         FROM audit_logs t WHERE tenant_id = ANY($1::uuid[])`,
      [[a.id, b.id]],
    );
    return rows[0].digest;
  }

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    owner = await connect(inject('migrationDatabaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
    memberA = await createMember(a, 'ADMIN');
    const memberB = await createMember(b, 'OWNER');
    rowOf = new Map([
      [a, (await auditAs(memberContext(memberA))).id],
      [b, (await auditAs(memberContext(memberB))).id],
    ]);
  });

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
  });

  it('acts as the runtime role and as the owner', async () => {
    const roleOf = async (client: Client) =>
      (await client.query<{ role: string }>('SELECT current_user AS role'))
        .rows[0].role;
    expect([await roleOf(app), await roleOf(owner)]).toEqual([
      'sadara_app',
      'sadara_owner',
    ]);
  });

  it('the_runtime_role_cannot_update_audit', async () => {
    const before = await evidence();
    for (const [tenant, id] of rowOf) {
      const update = [
        "UPDATE audit_logs SET action = 'tampered', new_values = '{}' WHERE id = $1",
        [id],
      ] as const;
      // The runtime role holds no UPDATE on audit…
      expect(await attempt(app, ...update, { tenant })).toEqual(
        refused(DENIED),
      );
      // …and the owner, who holds every right, is refused by the trigger.
      expect(await attempt(owner, ...update, { lift: true })).toEqual(
        refused(APPEND_ONLY('UPDATE')),
      );
      // Under forced row-level security the owner could not even reach it.
      expect(await attempt(owner, ...update)).toEqual({ rowCount: 0 });
    }
    expect(await evidence()).toBe(before);
  });

  it('the_runtime_role_cannot_delete_audit', async () => {
    const before = await evidence();
    for (const [tenant, id] of rowOf) {
      const remove = ['DELETE FROM audit_logs WHERE id = $1', [id]] as const;
      expect(await attempt(app, ...remove, { tenant })).toEqual(
        refused(DENIED),
      );
      expect(await attempt(owner, ...remove, { lift: true })).toEqual(
        refused(APPEND_ONLY('DELETE')),
      );
    }
    expect(await evidence()).toBe(before);
  });

  it('truncating_audit_is_refused', async () => {
    const before = await evidence();
    // TRUNCATE fires no row trigger: a statement trigger refuses it, even
    // for the owner, and the runtime role holds no TRUNCATE at all.
    expect(
      await attempt(app, 'TRUNCATE audit_logs', [], { tenant: a }),
    ).toEqual(refused(DENIED));
    expect(await attempt(owner, 'TRUNCATE audit_logs')).toEqual(
      refused(APPEND_ONLY('TRUNCATE')),
    );
    expect(
      await attempt(owner, 'TRUNCATE audit_logs', [], { lift: true }),
    ).toEqual(refused(APPEND_ONLY('TRUNCATE')));
    expect(await evidence()).toBe(before);
  });

  it('the_runtime_role_appends_and_reads_only_its_tenants_audit', async () => {
    const insert = (tenant: Tenant) =>
      [
        `INSERT INTO audit_logs (id, event_id, tenant_id, actor_type, actor_job, request_id,
                               outcome, schema_version, action, entity_type, entity_id)
       VALUES (gen_random_uuid(), uuidv7(), $1, 'SYSTEM', 'test-fixture', $2, 'SUCCEEDED', 1,
               'test.probe', 'Player', gen_random_uuid())`,
        [tenant.id, randomUUID()],
      ] as const;
    // Its own tenant's: appended.
    expect(await attempt(app, ...insert(a), { tenant: a })).toEqual({
      rowCount: 1,
    });
    // Another tenant's, in this tenant's transaction: refused by row-level
    // security.
    expect(await attempt(app, ...insert(b), { tenant: a })).toEqual(
      refused(
        /^new row violates row-level security policy for table "audit_logs"$/,
      ),
    );
    // And it reads its own tenant's rows only.
    for (const [tenant, id] of rowOf) {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant.id,
        ]);
        const { rows } = await app.query<{ id: string }>(
          'SELECT id FROM audit_logs WHERE id = ANY($1::uuid[])',
          [[...rowOf.values()]],
        );
        expect(rows).toEqual([{ id }]);
      } finally {
        await app.query('ROLLBACK');
      }
    }
  });

  it('an_audit_row_says_who_acted_and_in_which_request', async () => {
    // A member, as the context held them; and the system, by its job.
    const member = memberContext(memberA);
    const job = testContext(a.id);
    const columns = {
      actorType: true,
      userId: true,
      actorRole: true,
      actorSessionId: true,
      actorJob: true,
      requestId: true,
      outcome: true,
      schemaVersion: true,
      eventId: true,
    } as const;
    const read = (id: string) =>
      asTenant(a.id, (tx) =>
        tx.auditLog.findUniqueOrThrow({ where: { id }, select: columns }),
      );
    const actor = member.actor.kind === 'USER' ? member.actor : null;
    expect(await read((await auditAs(member)).id)).toEqual({
      actorType: 'USER',
      userId: memberA.id,
      actorRole: 'ADMIN',
      actorSessionId: actor?.sessionId,
      actorJob: null,
      requestId: member.requestId,
      outcome: 'SUCCEEDED',
      schemaVersion: AUDIT_SCHEMA_VERSION,
      eventId: expect.stringMatching(UUID_V7) as unknown,
    });
    expect(await read((await auditAs(job)).id)).toEqual({
      actorType: 'SYSTEM',
      userId: null,
      actorRole: null,
      actorSessionId: null,
      actorJob: 'test-fixture',
      requestId: job.requestId,
      outcome: 'SUCCEEDED',
      schemaVersion: AUDIT_SCHEMA_VERSION,
      eventId: expect.stringMatching(UUID_V7) as unknown,
    });

    // The database refuses a row whose actor does not hold together.
    const cases = [
      [
        'a member who names no member',
        'actor_type',
        "'USER'",
        'audit_logs_actor_check',
      ],
      [
        'the system naming a member',
        'actor_type, user_id',
        "'SYSTEM', $2",
        'audit_logs_actor_check',
      ],
      [
        'the system with a role',
        'actor_type, actor_role',
        "'SYSTEM', 'ADMIN'",
        'audit_logs_actor_check',
      ],
      [
        'the system with a session',
        'actor_type, actor_session_id',
        "'SYSTEM', gen_random_uuid()",
        'audit_logs_actor_check',
      ],
      [
        'a member with a job',
        'actor_type, user_id, actor_job',
        "'USER', $2, 'job'",
        'audit_logs_actor_check',
      ],
      [
        'the platform naming a member',
        'actor_type, user_id',
        "'PLATFORM', $2",
        'audit_logs_actor_check',
      ],
    ] as const;
    const insert = (columns: string, values: string, version = 1) =>
      attempt(
        app,
        `INSERT INTO audit_logs (id, event_id, tenant_id, outcome, schema_version, action,
                                 entity_type, entity_id, ${columns})
         VALUES (gen_random_uuid(), uuidv7(), $1, 'SUCCEEDED', ${version}, 'test.probe',
                 'Player', gen_random_uuid(), ${values})`,
        values.includes('$2') ? [a.id, memberA.id] : [a.id],
        { tenant: a },
      );
    const violates = (constraint: string) =>
      expect.objectContaining({
        code: CHECK_VIOLATION,
        message: expect.stringContaining(`"${constraint}"`) as unknown,
      }) as unknown;
    for (const [what, columns, values, constraint] of cases) {
      expect([what, await insert(columns, values)]).toEqual([
        what,
        violates(constraint),
      ]);
    }
    expect([
      'a payload version below 1',
      await insert('actor_type, actor_job', "'SYSTEM', 'job'", 0),
    ]).toEqual([
      'a payload version below 1',
      violates('audit_logs_schema_version_check'),
    ]);
    // The same row, its actor whole: appended.
    expect(await insert('actor_type, user_id', "'USER', $2")).toEqual({
      rowCount: 1,
    });
  });

  it('the_grants_and_triggers_hold_audit_append_only', async () => {
    // The runtime role: INSERT and SELECT, nothing else.
    const { rows: grants } = await owner.query<{ privilege: string }>(
      `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
        WHERE table_schema = current_schema() AND table_name = 'audit_logs'
          AND grantee = 'sadara_app' ORDER BY 1`,
    );
    expect(grants.map(({ privilege }) => privilege)).toEqual([
      'INSERT',
      'SELECT',
    ]);

    // Two triggers, enabled for every session, on the evidence function:
    // BEFORE UPDATE OR DELETE for each row, BEFORE TRUNCATE for the statement.
    const { rows: triggers } = await owner.query<{
      name: string;
      definition: string;
      enabled: string;
    }>(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition, tgenabled AS enabled
         FROM pg_trigger
        WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal
          AND tgname <> 'audit_logs_tenant_immutable'
        ORDER BY 1`,
    );
    expect(triggers).toEqual([
      {
        name: 'audit_logs_no_truncate',
        definition: expect.stringMatching(
          /BEFORE TRUNCATE ON \S*audit_logs FOR EACH STATEMENT EXECUTE FUNCTION \S*reject_evidence_mutation\(\)$/,
        ) as unknown,
        enabled: 'O',
      },
      {
        name: 'audit_logs_no_update_delete',
        definition: expect.stringMatching(
          /BEFORE DELETE OR UPDATE ON \S*audit_logs FOR EACH ROW EXECUTE FUNCTION \S*reject_evidence_mutation\(\)$/,
        ) as unknown,
        enabled: 'O',
      },
    ]);

    // The function refuses, and does nothing else: no setting, flag or role
    // lifts it.
    const { rows: functions } = await owner.query<{ body: string }>(
      `SELECT regexp_replace(prosrc, '\\s+', ' ', 'g') AS body FROM pg_proc
        WHERE proname = 'reject_evidence_mutation'
          AND pronamespace = current_schema()::regnamespace`,
    );
    expect(functions).toEqual([
      {
        body: " BEGIN RAISE EXCEPTION 'evidence is append-only: % on % is refused', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END ",
      },
    ]);

    // No row can be archived any more: deleted_at is gone.
    const { rows: columns } = await owner.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_logs'
          AND column_name = 'deleted_at'`,
    );
    expect(columns).toEqual([]);
  });

  describe('the migration, replayed on a schema as it was before it', () => {
    let replay: IsolatedSchema;
    let replayOwner: Client;
    let replayApp: Client;
    let tenants: Tenant[];
    let migration: string;

    // What 0.7.1 changed, undone: the schema as it stood after 0.6.7.
    const BEFORE_0_7_1 = `
      DROP TRIGGER audit_logs_no_update_delete ON audit_logs;
      DROP TRIGGER audit_logs_no_truncate ON audit_logs;
      DROP FUNCTION reject_evidence_mutation();
      DROP INDEX audit_logs_tenant_id_event_id_key;
      ALTER TABLE audit_logs
        DROP CONSTRAINT audit_logs_actor_check,
        DROP CONSTRAINT audit_logs_schema_version_check,
        DROP COLUMN event_id, DROP COLUMN actor_type, DROP COLUMN actor_role,
        DROP COLUMN actor_session_id, DROP COLUMN actor_job, DROP COLUMN request_id,
        DROP COLUMN reason, DROP COLUMN outcome, DROP COLUMN schema_version,
        ADD COLUMN deleted_at TIMESTAMPTZ(3);
      DROP TYPE audit_actor_type;
      DROP TYPE audit_outcome;
      GRANT UPDATE, DELETE ON audit_logs TO sadara_app;`;

    /** Every column a row had before, as the owner reads it. */
    const original = async () =>
      (
        await replayOwner.query<{ row: string }>(
          `SELECT concat_ws('|', id, tenant_id, user_id, action, entity_type, entity_id,
                            old_values, new_values, ip_address, user_agent, created_at) AS row
             FROM audit_logs ORDER BY id`,
        )
      ).rows.map(({ row }) => row);

    beforeAll(async () => {
      replay = await createIsolatedSchema();
      replayOwner = await connect(replay.migrationUrl);
      replayApp = await connect(replay.url);
      const root = join(__dirname, '../../prisma/migrations');
      const [folder] = readdirSync(root).filter((name) =>
        name.endsWith('_audit_append_only'),
      );
      migration = readFileSync(join(root, folder, 'migration.sql'), 'utf8');
      await replayOwner.query(BEFORE_0_7_1);

      // Rows written before 0.7.1, in two tenants: a member's, and the
      // platform's provisioning, which named no member.
      const db = prismaFor(replay.url);
      try {
        tenants = [
          await createTenant({ prisma: db.prisma }),
          await createTenant({ prisma: db.prisma }),
        ];
        for (const [n, tenant] of tenants.entries()) {
          const member = await createMember(tenant, 'ADMIN', db.prisma);
          await replayApp.query('BEGIN');
          await replayApp.query(
            "SELECT set_config('app.tenant_id', $1, true)",
            [tenant.id],
          );
          await replayApp.query(
            `INSERT INTO audit_logs (id, tenant_id, user_id, action, entity_type, entity_id,
                                     old_values, new_values, created_at)
             VALUES (gen_random_uuid(), $1, $2, 'invitation.created', 'Invitation',
                     gen_random_uuid(), NULL, '{"role": "COACH"}', $3),
                    (gen_random_uuid(), $1, NULL, 'tenant.provisioned', 'Tenant', $1,
                     NULL, '{"locale": "ar"}', $4)`,
            [
              tenant.id,
              member.id,
              `2026-11-0${n + 1}T10:15:30.123Z`,
              `2026-10-2${n + 1}T08:00:00.456Z`,
            ],
          );
          await replayApp.query('COMMIT');
        }
      } finally {
        await db.close();
      }
    });

    afterAll(async () => {
      await Promise.all([replayOwner?.end(), replayApp?.end()]);
      await replay?.drop();
    });

    it('an_archived_audit_row_stops_the_migration', async () => {
      const before = await original();
      // An archived row, and the migration after it, in one transaction.
      await replayOwner.query('BEGIN');
      let failure: DatabaseError | undefined;
      try {
        await replayOwner.query(
          'ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY',
        );
        await replayOwner.query(
          `INSERT INTO audit_logs (id, tenant_id, action, entity_type, entity_id, deleted_at)
           VALUES (gen_random_uuid(), $1, 'test.probe', 'Player', gen_random_uuid(), now())`,
          [tenants[0].id],
        );
        await replayOwner.query(migration);
      } catch (error) {
        failure = error as DatabaseError;
      } finally {
        await replayOwner.query('ROLLBACK');
      }
      expect(failure).toMatchObject({
        message:
          'an audit row is archived: audit evidence is never undeleted or erased',
        hint: expect.stringContaining('deleted_audit_row') as unknown,
      });
      // Nothing changed: the rows, and deleted_at, are as they were.
      expect(await original()).toEqual(before);
    });

    it('the_migration_keeps_every_row_and_fills_its_columns', async () => {
      const before = await original();
      await replayOwner.query('BEGIN');
      await replayOwner.query(migration);
      await replayOwner.query('COMMIT');

      // Every row, every column it had, as it was.
      expect(await original()).toEqual(before);
      const { rows } = await replayOwner.query<Record<string, unknown>>(
        `SELECT user_id IS NOT NULL AS member_named, actor_type, actor_role, actor_session_id,
                actor_job, request_id, reason, outcome, schema_version,
                uuid_extract_version(event_id) AS event_version,
                uuid_extract_timestamp(event_id) = date_trunc('milliseconds', created_at)
                  AS event_at_creation
           FROM audit_logs ORDER BY created_at`,
      );
      const filled = (memberNamed: boolean) => ({
        member_named: memberNamed,
        actor_type: memberNamed ? 'USER' : 'SYSTEM',
        actor_role: null,
        actor_session_id: null,
        actor_job: null,
        request_id: null,
        reason: null,
        outcome: 'SUCCEEDED',
        schema_version: 1,
        event_version: 7,
        event_at_creation: true,
      });
      expect(rows).toEqual([
        filled(false),
        filled(false),
        filled(true),
        filled(true),
      ]);
      const { rows: distinct } = await replayOwner.query<{ n: number }>(
        'SELECT count(DISTINCT event_id)::int AS n FROM audit_logs',
      );
      expect(distinct).toEqual([{ n: 4 }]);
    });

    it('a_runtime_role_granted_too_much_is_still_refused', async () => {
      // A grant restored by mistake does not reopen audit: the triggers
      // refuse every role, whatever it holds.
      await replayOwner.query(
        'GRANT UPDATE, DELETE, TRUNCATE ON audit_logs TO sadara_app',
      );
      const [tenant] = tenants;
      expect(
        await attempt(
          replayApp,
          "UPDATE audit_logs SET action = 'tampered'",
          [],
          { tenant },
        ),
      ).toEqual(refused(APPEND_ONLY('UPDATE')));
      expect(
        await attempt(replayApp, 'DELETE FROM audit_logs', [], { tenant }),
      ).toEqual(refused(APPEND_ONLY('DELETE')));
      expect(
        await attempt(replayApp, 'TRUNCATE audit_logs', [], { tenant }),
      ).toEqual(refused(APPEND_ONLY('TRUNCATE')));
    });
  });
});
