import { randomUUID } from 'node:crypto';
import type { Player, Season, Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import type { TenantTx } from '../../src/common/tenancy/tenant-transaction';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
} from '../harness/fixtures';

/** The tables the runtime role only reads (`contained`, 0.8.2): written as the owner. */
const CONTAINED = new Set(['documents']);

// Composite and same-parent foreign keys (0.4.4). Every refusal is a raw
// statement as the runtime role, so it is PostgreSQL that refuses, not Prisma
// or a use case. Each is paired with the same statement naming a parent that
// does belong, so the refusal is the key's and nothing else's. The statements
// run as tenant A, which row-level security (0.4.5) requires of any write; a
// key's check reads the parent whatever its tenant, so another tenant's
// parent is still found, and refused.

// A row naming a parent that is not there, and a parent change a key restricts.
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

type Outcome = 'succeeded' | { code?: string; constraint?: string };

/** What a statement did: 'succeeded', or the SQLSTATE and the constraint that refused it. */
async function outcomeOf(statement: Promise<unknown>): Promise<Outcome> {
  try {
    await statement;
    return 'succeeded';
  } catch (error) {
    const { code, constraint } = error as DatabaseError;
    return { code, constraint };
  }
}

const refusedBy = (constraint: string): Outcome => ({
  code: FOREIGN_KEY_VIOLATION,
  constraint,
});
const restrictedBy = (constraint: string): Outcome => ({
  code: RESTRICT_VIOLATION,
  constraint,
});

interface ForeignKey {
  name: string;
  child: string;
  parent: string;
  columns: string[];
  parentColumns: string[];
  onDelete: string;
  onUpdate: string;
  validated: boolean;
}

describe('composite and same-parent foreign keys', () => {
  let app: Client;
  /** The migrator, acting as the owner: it alone writes a contained table (0.8.2). */
  let owner: Client;
  let a: Tenant;
  let b: Tenant;
  let memberA: User;
  let memberB: User;
  let playerA: Player;
  let seasonA: Season;
  let seasonB: Season;
  let keys: ForeignKey[];

  /** Work as tenant A, through the tenant transaction. */
  const asA = <T>(work: (tx: TenantTx) => Promise<T>) => asTenant(a.id, work);

  /**
   * INSERT INTO <table>, as the runtime role, with a fresh id — or, into a
   * contained table, as the owner, its forced RLS lifted for the statement, as
   * a migration writes one.
   */
  const insert = async (table: string, row: Record<string, unknown>) => {
    const values: Record<string, unknown> = { id: randomUUID(), ...row };
    const columns = Object.keys(values);
    const params = columns.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${params.join(', ')})`;
    if (!CONTAINED.has(table)) return app.query(sql, Object.values(values));
    await owner.query('BEGIN');
    try {
      await owner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      const result = await owner.query(sql, Object.values(values));
      await owner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await owner.query('COMMIT');
      return result;
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  };

  const seasonOf = (tenant: Tenant) =>
    asTenant(tenant.id, (tx) =>
      tx.season.create({
        data: {
          tenantId: tenant.id,
          name: '2026/27',
          startDate: day('2026-08-01'),
          endDate: day('2027-05-31'),
        },
      }),
    );

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    owner = await connect(inject('migrationDatabaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
    // This connection is tenant A's for the whole file: a test's own
    // connection, never one of the application's pool.
    await app.query("SELECT set_config('app.tenant_id', $1, false)", [a.id]);
    [memberA, memberB] = await Promise.all([
      createMember(a, 'COACH'),
      createMember(b, 'COACH'),
    ]);
    playerA = await createPlayer(a);
    [seasonA, seasonB] = await Promise.all([seasonOf(a), seasonOf(b)]);

    const { rows } = await app.query<ForeignKey>(
      `SELECT c.conname AS name,
              c.conrelid::regclass::text AS child,
              c.confrelid::regclass::text AS parent,
              ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(n, i)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i) AS columns,
              ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(n, i)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i) AS "parentColumns",
              c.confdeltype AS "onDelete",
              c.confupdtype AS "onUpdate",
              c.convalidated AS validated
       FROM pg_constraint c
       WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace
       ORDER BY 1`,
    );
    keys = rows;
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it('foreign_keys_refuse_cross_tenant_edges', async () => {
    const now = new Date();
    const conversationA = await asA((tx) =>
      tx.conversation.create({ data: { tenantId: a.id } }),
    );
    // The seven references that named a row by its id alone, or not at all.
    const edges: Array<{
      key: string;
      ours: unknown;
      theirs: unknown;
      row: (parent: unknown) => [string, Record<string, unknown>];
    }> = [
      {
        key: 'contracts_season_id_tenant_id_fkey',
        ours: seasonA.id,
        theirs: seasonB.id,
        row: (season) => [
          'contracts',
          {
            tenant_id: a.id,
            player_id: playerA.id,
            created_by_id: memberA.id,
            season_id: season,
            title: 'Test contract',
            start_date: day('2026-08-01'),
            end_date: day('2028-06-30'),
            updated_at: now,
          },
        ],
      },
      {
        key: 'performance_records_season_id_tenant_id_fkey',
        ours: seasonA.id,
        theirs: seasonB.id,
        row: (season) => [
          'performance_records',
          {
            tenant_id: a.id,
            player_id: playerA.id,
            season_id: season,
            match_date: day('2026-09-12'),
            updated_at: now,
          },
        ],
      },
      {
        key: 'trainings_season_id_tenant_id_fkey',
        ours: seasonA.id,
        theirs: seasonB.id,
        row: (season) => [
          'trainings',
          {
            tenant_id: a.id,
            season_id: season,
            title: 'Test programme',
            start_date: day('2026-07-01'),
            end_date: day('2026-07-31'),
            updated_at: now,
          },
        ],
      },
      {
        key: 'legal_tickets_assigned_to_id_tenant_id_fkey',
        ours: memberA.id,
        theirs: memberB.id,
        row: (assignee) => [
          'legal_tickets',
          {
            tenant_id: a.id,
            player_id: playerA.id,
            created_by_id: memberA.id,
            assigned_to_id: assignee,
            subject: 'Test ticket',
            description: 'Synthetic',
            updated_at: now,
          },
        ],
      },
      {
        key: 'messages_sender_id_tenant_id_fkey',
        ours: memberA.id,
        theirs: memberB.id,
        row: (sender) => [
          'messages',
          {
            tenant_id: a.id,
            conversation_id: conversationA.id,
            sender_id: sender,
            type: 'TEXT',
            updated_at: now,
          },
        ],
      },
      {
        key: 'audit_logs_user_id_tenant_id_fkey',
        ours: memberA.id,
        theirs: memberB.id,
        row: (user) => [
          'audit_logs',
          {
            event_id: randomUUID(),
            tenant_id: a.id,
            // A member is named exactly when one acted (0.7.1).
            actor_type: user === null ? 'SYSTEM' : 'USER',
            user_id: user,
            outcome: 'SUCCEEDED',
            schema_version: 1,
            action: 'UPDATE',
            entity_type: 'Player',
            entity_id: playerA.id,
          },
        ],
      },
      {
        key: 'documents_uploaded_by_id_tenant_id_fkey',
        ours: memberA.id,
        theirs: memberB.id,
        row: (uploader) => [
          'documents',
          {
            tenant_id: a.id,
            entity_type: 'PLAYER',
            entity_id: playerA.id,
            file_url: 'objects/test',
            file_name: 'test.pdf',
            uploaded_by_id: uploader,
            updated_at: now,
          },
        ],
      },
    ];

    for (const { key, ours, theirs, row } of edges) {
      expect([key, await outcomeOf(insert(...row(theirs)))]).toEqual([
        key,
        refusedBy(key),
      ]);
      expect([key, await outcomeOf(insert(...row(ours)))]).toEqual([
        key,
        'succeeded',
      ]);
      // A reference may still be empty: MATCH SIMPLE checks nothing when it is.
      expect([key, await outcomeOf(insert(...row(null)))]).toEqual([
        key,
        'succeeded',
      ]);
    }

    // And no key anywhere can do it: a reference to a tenant-owned table pairs
    // tenant_id with tenant_id. Every key is validated, none left NOT VALID.
    const { rows } = await app.query<{ table: string }>(
      `SELECT table_name AS table FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'tenant_id'`,
    );
    const tenantOwned = new Set(rows.map((row) => row.table));
    const paired = (fk: ForeignKey) =>
      fk.parentColumns.some(
        (column, i) => column === 'tenant_id' && fk.columns[i] === 'tenant_id',
      );
    expect(tenantOwned.has('seasons')).toBe(true);
    expect(
      keys
        .filter((fk) => tenantOwned.has(fk.parent) && !paired(fk))
        .map((fk) => fk.name),
    ).toEqual([]);
    expect(keys.filter((fk) => !fk.validated).map((fk) => fk.name)).toEqual([]);
  });

  it('a_treatment_cannot_cite_another_players_record', async () => {
    const otherPlayer = await createPlayer(a);
    const recordOf = (player: Player, tenant = a, creator = memberA) =>
      asTenant(tenant.id, (tx) =>
        tx.medicalRecord.create({
          data: {
            tenantId: tenant.id,
            playerId: player.id,
            createdById: creator.id,
            injuryType: 'Test injury',
          },
        }),
      );
    const own = await recordOf(playerA);
    const another = await recordOf(otherPlayer);
    const otherTenant = await recordOf(await createPlayer(b), b, memberB);
    const treatment = (record: string | null) =>
      insert('treatment_sessions', {
        tenant_id: a.id,
        player_id: playerA.id,
        medical_record_id: record,
        session_date: day('2026-09-20'),
        treatment_type: 'Physiotherapy',
        conducted_by: memberA.id,
        updated_at: new Date(),
      });
    const key = 'treatment_sessions_medical_record_id_tenant_id_player_id_fkey';

    expect(await outcomeOf(treatment(another.id))).toEqual(refusedBy(key));
    expect(await outcomeOf(treatment(otherTenant.id))).toEqual(refusedBy(key));
    expect(await outcomeOf(treatment(own.id))).toBe('succeeded');
    expect(await outcomeOf(treatment(null))).toBe('succeeded');

    // Nor can the record move to another player once a session cites it.
    expect(
      await outcomeOf(
        app.query('UPDATE medical_records SET player_id = $1 WHERE id = $2', [
          otherPlayer.id,
          own.id,
        ]),
      ),
    ).toEqual(restrictedBy(key));
  });

  it('attendance_cannot_mix_training_programs', async () => {
    const programme = (title: string) =>
      asA((tx) =>
        tx.training.create({
          data: {
            tenantId: a.id,
            title,
            startDate: day('2026-09-01'),
            endDate: day('2026-10-31'),
          },
        }),
      );
    const [one, two] = [
      await programme('Programme one'),
      await programme('Programme two'),
    ];
    const enrollment = await asA((tx) =>
      tx.enrollment.create({
        data: { tenantId: a.id, trainingId: one.id, playerId: playerA.id },
      }),
    );
    const sessionOf = (training: { id: string }) =>
      asA((tx) =>
        tx.trainingSession.create({
          data: {
            tenantId: a.id,
            trainingId: training.id,
            date: day('2026-10-05'),
            timeZone: 'Asia/Amman',
          },
        }),
      );
    const [sessionOne, sessionTwo] = [
      await sessionOf(one),
      await sessionOf(two),
    ];
    const attendance = (session: { id: string }, training: { id: string }) =>
      insert('attendance', {
        tenant_id: a.id,
        enrollment_id: enrollment.id,
        training_session_id: session.id,
        training_id: training.id,
        date: day('2026-10-05'),
        updated_at: new Date(),
      });

    // Programme one's enrollment at programme two's session, whichever
    // programme the row claims: one of the two keys refuses it.
    expect(await outcomeOf(attendance(sessionTwo, one))).toEqual(
      refusedBy('attendance_training_session_id_tenant_id_training_id_fkey'),
    );
    expect(await outcomeOf(attendance(sessionTwo, two))).toEqual(
      refusedBy('attendance_enrollment_id_tenant_id_training_id_fkey'),
    );
    expect(await outcomeOf(attendance(sessionOne, one))).toBe('succeeded');

    // Nor can the session move to another programme once attendance cites it.
    expect(
      await outcomeOf(
        app.query(
          'UPDATE training_sessions SET training_id = $1 WHERE id = $2',
          [two.id, sessionOne.id],
        ),
      ),
    ).toEqual(
      restrictedBy('attendance_training_session_id_tenant_id_training_id_fkey'),
    );
  });

  it('no_composite_foreign_key_uses_set_null', async () => {
    // SET NULL on (player_id, tenant_id) would null tenant_id too; SET DEFAULT
    // would rewrite it. A composite key restricts instead.
    expect(
      keys
        .filter((fk) => fk.columns.length > 1)
        .filter((fk) => fk.onDelete === 'n' || fk.onDelete === 'd')
        .map((fk) => fk.name),
    ).toEqual([]);

    // The two that did: deleting the parent is refused, and the child keeps
    // its reference and its tenant.
    const scouted = await createPlayer(a);
    const report = await asA((tx) =>
      tx.scoutingReport.create({
        data: {
          tenantId: a.id,
          scoutId: memberA.id,
          playerId: scouted.id,
          reportDate: day('2026-09-01'),
        },
      }),
    );
    expect(
      await outcomeOf(
        app.query('DELETE FROM players WHERE id = $1', [scouted.id]),
      ),
    ).toEqual(restrictedBy('scouting_reports_player_id_tenant_id_fkey'));
    const record = await asA((tx) =>
      tx.medicalRecord.create({
        data: {
          tenantId: a.id,
          playerId: playerA.id,
          createdById: memberA.id,
          injuryType: 'Test injury',
        },
      }),
    );
    const treatment = await asA((tx) =>
      tx.treatmentSession.create({
        data: {
          tenantId: a.id,
          playerId: playerA.id,
          medicalRecordId: record.id,
          conductedBy: memberA.id,
          sessionDate: day('2026-09-21'),
          treatmentType: 'Physiotherapy',
        },
      }),
    );
    expect(
      await outcomeOf(
        app.query('DELETE FROM medical_records WHERE id = $1', [record.id]),
      ),
    ).toEqual(
      restrictedBy(
        'treatment_sessions_medical_record_id_tenant_id_player_id_fkey',
      ),
    );
    expect(
      await asA((tx) =>
        tx.scoutingReport.findUniqueOrThrow({
          where: { id: report.id },
          select: { playerId: true, tenantId: true },
        }),
      ),
    ).toEqual({ playerId: scouted.id, tenantId: a.id });
    expect(
      await asA((tx) =>
        tx.treatmentSession.findUniqueOrThrow({
          where: { id: treatment.id },
          select: { medicalRecordId: true, tenantId: true },
        }),
      ),
    ).toEqual({ medicalRecordId: record.id, tenantId: a.id });
  });

  it('no_foreign_key_cascades_a_key_change', async () => {
    // Every key refuses a change to the parent key it names (ON UPDATE
    // RESTRICT), rather than rewriting its children's columns, tenant_id
    // among them.
    expect(keys.length).toBeGreaterThan(0);
    expect(
      keys.filter((fk) => fk.onUpdate !== 'r').map((fk) => fk.name),
    ).toEqual([]);

    const member = await createMember(a, 'COACH');
    const ticket = await asA((tx) =>
      tx.legalTicket.create({
        data: {
          tenantId: a.id,
          playerId: playerA.id,
          createdById: member.id,
          subject: 'Test ticket',
          description: 'Synthetic',
        },
      }),
    );
    // A member's id cannot change while a ticket names it. (Their tenant_id
    // cannot change at all: the trigger of 0.4.5 refuses that first.)
    const renamed = await outcomeOf(
      app.query('UPDATE users SET id = $1 WHERE id = $2', [
        randomUUID(),
        member.id,
      ]),
    );
    expect(renamed).toEqual(
      restrictedBy('legal_tickets_created_by_id_tenant_id_fkey'),
    );
    const renumbered = await outcomeOf(
      app.query('UPDATE players SET id = $1 WHERE id = $2', [
        randomUUID(),
        playerA.id,
      ]),
    );
    expect(renumbered).toMatchObject({ code: RESTRICT_VIOLATION });
    expect(
      await asA((tx) =>
        tx.legalTicket.findUniqueOrThrow({
          where: { id: ticket.id },
          select: { tenantId: true, createdById: true, playerId: true },
        }),
      ),
    ).toEqual({ tenantId: a.id, createdById: member.id, playerId: playerA.id });
  });
});
