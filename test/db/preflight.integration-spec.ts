import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type Tenant } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantTx } from '../../src/common/tenancy/tenant-transaction';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  PreflightRefused,
  runPreflight,
  type PreflightReport,
  type Violation,
} from '../../scripts/preflight';
import {
  createIsolatedSchema,
  prismaFor,
  type IsolatedSchema,
} from '../harness/db';
import { asTenant } from '../harness/fixtures';

// The preflight inspects a whole schema, so it gets schemas of its own: one
// seeded with a counter-example for every rule, one clean. Every value is
// synthetic; the personal-looking ones exist to prove none of them leaks. It
// runs as the migrator, which reads every tenant's rows (0.4.5).

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Runs raw SQL in an isolated schema: as the runtime role, for values Prisma
 * will not write (NaN); as the migrator (`url`), for changes to the schema.
 */
async function sqlIn(
  schema: IsolatedSchema,
  statements: Array<[text: string, params?: unknown[]]>,
  url: string = schema.url,
) {
  const client = new Client({
    connectionString: databaseConnectionOf(url).connectionString,
  });
  await client.connect();
  try {
    await client.query(
      "SELECT set_config('search_path', quote_ident($1), false)",
      [schema.schema],
    );
    for (const [text, params] of statements) await client.query(text, params);
  } finally {
    await client.end();
  }
}

// The preflight runs on a database from before its constraints, and the keys
// of 0.4.4 refuse the very rows it must find. The dirty schema gets back the
// keys it had before them: the single-column ones the cross-tenant rule reads
// from the catalog, and the composites without the shared parent.
const KEYS_BEFORE_0_4_4 = [
  'ALTER TABLE attendance DROP CONSTRAINT attendance_enrollment_id_tenant_id_training_id_fkey,' +
    ' ADD FOREIGN KEY (enrollment_id, tenant_id) REFERENCES enrollments (id, tenant_id)',
  'ALTER TABLE attendance DROP CONSTRAINT attendance_training_session_id_tenant_id_training_id_fkey,' +
    ' ADD FOREIGN KEY (training_session_id, tenant_id) REFERENCES training_sessions (id, tenant_id)',
  'ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_user_id_tenant_id_fkey,' +
    ' ADD FOREIGN KEY (user_id) REFERENCES users (id)',
  'ALTER TABLE contracts DROP CONSTRAINT contracts_season_id_tenant_id_fkey,' +
    ' ADD FOREIGN KEY (season_id) REFERENCES seasons (id)',
  'ALTER TABLE documents DROP CONSTRAINT documents_uploaded_by_id_tenant_id_fkey',
  'ALTER TABLE legal_tickets DROP CONSTRAINT legal_tickets_assigned_to_id_tenant_id_fkey,' +
    ' ADD FOREIGN KEY (assigned_to_id) REFERENCES users (id)',
  'ALTER TABLE messages DROP CONSTRAINT messages_sender_id_tenant_id_fkey,' +
    ' ADD FOREIGN KEY (sender_id) REFERENCES users (id)',
  'ALTER TABLE performance_records DROP CONSTRAINT performance_records_season_id_tenant_id_fkey,' +
    ' ADD FOREIGN KEY (season_id) REFERENCES seasons (id)',
  'ALTER TABLE trainings DROP CONSTRAINT trainings_season_id_tenant_id_fkey,' +
    ' ADD FOREIGN KEY (season_id) REFERENCES seasons (id)',
  'ALTER TABLE treatment_sessions DROP CONSTRAINT treatment_sessions_medical_record_id_tenant_id_player_id_fkey,' +
    ' ADD FOREIGN KEY (medical_record_id, tenant_id) REFERENCES medical_records (id, tenant_id)',
];

const PERSONAL = {
  memberEmail: 'Layla.Haddad@agency-one.test',
  duplicateEmail: ' layla.haddad@agency-one.test',
  otherTenantEmail: 'omar.saleh@agency-two.test',
  // Deliberately off the reserved domains, as a real person's address would
  // be; the address itself is invented.
  realLookingEmail: 'k.nasser@nasser-sports.com',
  playerName: 'Yousef Abu Hamdan',
  otherPlayerName: 'Sami Al-Khatib',
  ticketSubject: 'Agent dispute about Yousef Abu Hamdan',
  ticketDescription: 'Confidential: the agent disputes the transfer clause',
  injury: 'Anterior cruciate ligament tear',
  fileName: 'passport-scan-yousef.pdf',
  notification: 'Your contract expires in 30 days',
  salary: '123456.78',
};

interface Seeded {
  a: Tenant;
  b: Tenant;
  crossTenant: Record<string, string>; // table → the row that crosses tenants
  sameParent: Record<string, string>;
  orphans: string[];
  duplicates: string[];
  money: string[];
  deletedAudit: string;
  realAccount: string;
}

async function seedCounterExamples(
  prisma: PrismaClient,
  schema: IsolatedSchema,
): Promise<Seeded> {
  // Row-level security (0.4.5): each row is written as its own tenant.
  const tenant = (name: string, slug: string) => {
    const id = randomUUID();
    return asTenant(
      id,
      (tx) => tx.tenant.create({ data: { id, name, slug } }),
      prisma,
    );
  };
  const a = await tenant('Agency One', `one-${randomUUID().slice(0, 8)}`);
  const b = await tenant('Agency Two', `two-${randomUUID().slice(0, 8)}`);
  const member = (tx: TenantTx, tenantId: string, email: string) =>
    tx.user.create({
      data: {
        tenantId,
        email,
        role: 'COACH',
      },
    });

  // Tenant B's rows, which tenant A's name across the boundary.
  const [memberB, seasonB] = await asTenant(
    b.id,
    async (tx) =>
      [
        await member(tx, b.id, PERSONAL.otherTenantEmail),
        await tx.season.create({
          data: {
            tenantId: b.id,
            name: '2026/27',
            startDate: day('2026-08-01'),
            endDate: day('2027-05-31'),
          },
        }),
      ] as const,
    prisma,
  );

  const seeded = await asTenant(
    a.id,
    async (tx) => {
      const memberA = await member(tx, a.id, PERSONAL.memberEmail);
      const duplicate = await member(tx, a.id, PERSONAL.duplicateEmail);
      const realAccount = await member(tx, a.id, PERSONAL.realLookingEmail);
      const player = await tx.player.create({
        data: { tenantId: a.id, fullName: PERSONAL.playerName },
      });
      const otherPlayer = await tx.player.create({
        data: { tenantId: a.id, fullName: PERSONAL.otherPlayerName },
      });

      // The six single-column references, each pointing into tenant B.
      const contract = await tx.contract.create({
        data: {
          tenantId: a.id,
          playerId: player.id,
          createdById: memberA.id,
          seasonId: seasonB.id,
          title: 'Professional contract',
          startDate: day('2026-08-01'),
          endDate: day('2028-06-30'),
          salaryAmount: new Prisma.Decimal(PERSONAL.salary),
        },
      });
      const performance = await tx.performanceRecord.create({
        data: {
          tenantId: a.id,
          playerId: player.id,
          seasonId: seasonB.id,
          matchDate: day('2026-09-12'),
        },
      });
      const training = await tx.training.create({
        data: {
          tenantId: a.id,
          seasonId: seasonB.id,
          title: 'Pre-season',
          startDate: day('2026-07-01'),
          endDate: day('2026-07-31'),
        },
      });
      const ticket = await tx.legalTicket.create({
        data: {
          tenantId: a.id,
          playerId: player.id,
          createdById: memberA.id,
          assignedToId: memberB.id,
          subject: PERSONAL.ticketSubject,
          description: PERSONAL.ticketDescription,
        },
      });
      const conversation = await tx.conversation.create({
        data: { tenantId: a.id },
      });
      const message = await tx.message.create({
        data: {
          tenantId: a.id,
          conversationId: conversation.id,
          senderId: memberB.id,
          type: 'TEXT',
        },
      });
      const audit = await tx.auditLog.create({
        data: {
          tenantId: a.id,
          userId: memberB.id,
          action: 'UPDATE',
          entityType: 'Player',
          entityId: player.id,
        },
      });

      // Same tenant, different parents.
      const record = await tx.medicalRecord.create({
        data: {
          tenantId: a.id,
          playerId: otherPlayer.id,
          createdById: memberA.id,
          injuryType: PERSONAL.injury,
        },
      });
      const treatment = await tx.treatmentSession.create({
        data: {
          tenantId: a.id,
          playerId: player.id,
          medicalRecordId: record.id,
          conductedBy: memberA.id,
          sessionDate: day('2026-09-20'),
          treatmentType: 'Physiotherapy',
        },
      });
      const programOne = await tx.training.create({
        data: {
          tenantId: a.id,
          title: 'Programme one',
          startDate: day('2026-09-01'),
          endDate: day('2026-09-30'),
        },
      });
      const programTwo = await tx.training.create({
        data: {
          tenantId: a.id,
          title: 'Programme two',
          startDate: day('2026-10-01'),
          endDate: day('2026-10-31'),
        },
      });
      const enrollment = await tx.enrollment.create({
        data: {
          tenantId: a.id,
          trainingId: programOne.id,
          playerId: player.id,
          paidAmount: new Prisma.Decimal('-50.00'),
        },
      });
      const session = await tx.trainingSession.create({
        data: {
          tenantId: a.id,
          trainingId: programTwo.id,
          date: day('2026-10-05'),
        },
      });
      const attendance = await tx.attendance.create({
        data: {
          tenantId: a.id,
          enrollmentId: enrollment.id,
          trainingSessionId: session.id,
          trainingId: programOne.id, // the enrollment's; the session is programme two's
          date: day('2026-10-05'),
        },
      });

      // References no foreign key protects, naming nothing.
      const missingEntity = await tx.document.create({
        data: {
          tenantId: a.id,
          entityType: 'PLAYER',
          entityId: randomUUID(),
          fileUrl: 'objects/x',
          fileName: PERSONAL.fileName,
        },
      });
      const missingUploader = await tx.document.create({
        data: {
          tenantId: a.id,
          entityType: 'PLAYER',
          entityId: player.id,
          uploadedById: randomUUID(),
          fileUrl: 'objects/y',
          fileName: PERSONAL.fileName,
        },
      });

      const deletedAudit = await tx.auditLog.create({
        data: {
          tenantId: a.id,
          userId: memberA.id,
          action: 'DELETE',
          entityType: 'Player',
          entityId: player.id,
          deletedAt: new Date(),
        },
      });
      await tx.notification.create({
        data: {
          tenantId: a.id,
          userId: memberA.id,
          type: 'CONTRACT_EXPIRING',
          content: PERSONAL.notification,
          referenceType: 'contract',
          referenceId: contract.id,
        },
      });

      return {
        crossTenant: {
          contracts: contract.id,
          performance_records: performance.id,
          trainings: training.id,
          legal_tickets: ticket.id,
          messages: message.id,
          audit_logs: audit.id,
        },
        sameParent: {
          treatment_sessions: treatment.id,
          attendance: attendance.id,
        },
        orphans: [missingEntity.id, missingUploader.id],
        duplicates: [memberA.id, duplicate.id],
        money: [contract.id, enrollment.id],
        deletedAudit: deletedAudit.id,
        realAccount: realAccount.id,
      };
    },
    prisma,
  );

  // Money: NaN cannot be written through Prisma, a negative amount can. Written
  // once the rows above are committed, as tenant A.
  await sqlIn(schema, [
    ["SELECT set_config('app.tenant_id', $1, false)", [a.id]],
    [
      `UPDATE contracts SET signing_fee = 'NaN' WHERE id = $1`,
      [seeded.crossTenant.contracts],
    ],
  ]);

  return { a, b, ...seeded };
}

const ofRule = (report: PreflightReport, rule: string): Violation[] =>
  report.violations.filter((v) => v.rule === rule);

describe('the preflight report', () => {
  let dirty: IsolatedSchema;
  let clean: IsolatedSchema;
  let seeded: Seeded;
  let report: PreflightReport;

  beforeAll(async () => {
    [dirty, clean] = await Promise.all([
      createIsolatedSchema(),
      createIsolatedSchema(),
    ]);
    await sqlIn(
      dirty,
      KEYS_BEFORE_0_4_4.map((statement) => [statement]),
      dirty.migrationUrl,
    );
    const db = prismaFor(dirty.url);
    try {
      seeded = await seedCounterExamples(db.prisma, dirty);
    } finally {
      await db.close();
    }
    report = await runPreflight(dirty.migrationUrl);
  });

  afterAll(async () => {
    await Promise.all([dirty?.drop(), clean?.drop()]);
  });

  it('preflight_reports_cross_tenant_edges', () => {
    const found = ofRule(report, 'cross_tenant_edge');
    expect(found).toHaveLength(6);
    for (const [table, rowId] of Object.entries(seeded.crossTenant)) {
      expect(found).toContainEqual(
        expect.objectContaining({ table, rowId, tenantId: seeded.a.id }),
      );
    }
    expect(found.map((v) => v.reason).sort()).toEqual([
      'audit_logs.user_id names a row of another tenant in users',
      'contracts.season_id names a row of another tenant in seasons',
      'legal_tickets.assigned_to_id names a row of another tenant in users',
      'messages.sender_id names a row of another tenant in users',
      'performance_records.season_id names a row of another tenant in seasons',
      'trainings.season_id names a row of another tenant in seasons',
    ]);
  });

  it('preflight_reports_same_parent_violations', () => {
    const found = ofRule(report, 'same_parent');
    expect(found).toHaveLength(2);
    for (const [table, rowId] of Object.entries(seeded.sameParent)) {
      expect(found).toContainEqual(
        expect.objectContaining({ table, rowId, tenantId: seeded.a.id }),
      );
    }
  });

  it('reports every other rule on its counter-example', () => {
    expect(
      ofRule(report, 'orphaned_reference')
        .map((v) => v.rowId)
        .sort(),
    ).toEqual([...seeded.orphans].sort());
    expect(
      ofRule(report, 'duplicate_email')
        .map((v) => v.rowId)
        .sort(),
    ).toEqual([...seeded.duplicates].sort());
    expect(
      ofRule(report, 'money_out_of_range')
        .map((v) => v.rowId)
        .sort(),
    ).toEqual([...seeded.money].sort());
    expect(ofRule(report, 'deleted_audit_row').map((v) => v.rowId)).toEqual([
      seeded.deletedAudit,
    ]);
    expect(ofRule(report, 'real_account').map((v) => v.rowId)).toEqual([
      seeded.realAccount,
    ]);
    expect(report.counts).toEqual({
      cross_tenant_edge: 6,
      same_parent: 2,
      orphaned_reference: 2,
      duplicate_email: 2,
      money_out_of_range: 2,
      deleted_audit_row: 1,
      real_account: 1,
    });

    const unknown = (rule: string, table: string, column: string) =>
      report.unknowns.find(
        (u) => u.rule === rule && u.table === table && u.column === column,
      );
    expect(
      unknown('unverifiable_reference', 'notifications', 'reference_id')?.count,
    ).toBe(1);
    expect(
      unknown('money_currency_unknown', 'enrollments', 'paid_amount')?.count,
    ).toBe(1);
    // The credential columns are gone (0.1.6): no secret material is left to find.
    expect(report.unknowns.filter((u) => u.rule === 'secret_material')).toEqual(
      [],
    );
    expect(unknown('timestamp_provenance', 'users', 'created_at')?.count).toBe(
      4,
    );
    expect(report.schemaVersion).toMatch(/^\d{14}_\w+$/);
  });

  it('preflight_output_contains_no_personal_data', () => {
    const output = JSON.stringify(report).toLowerCase();
    for (const value of Object.values(PERSONAL)) {
      expect(output).not.toContain(value.trim().toLowerCase());
    }
    expect(output).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no address at all
  });

  it('reports zero on a clean database', async () => {
    const tidy = await runPreflight(clean.migrationUrl);
    expect(tidy.violations).toEqual([]);
    expect(Object.values(tidy.counts).every((count) => count === 0)).toBe(true);
    expect(Object.keys(tidy.counts).sort()).toEqual(
      Object.keys(report.counts).sort(),
    );
    expect(tidy.unknowns).toEqual([]);
  });

  it('refuses a role that row-level security hides rows from', async () => {
    // The runtime role sees no tenant's rows without one: as it, the dirty
    // schema would look clean.
    await expect(runPreflight(dirty.url)).rejects.toThrow(PreflightRefused);
    await expect(runPreflight(dirty.url)).rejects.toThrow(
      /hides rows of .*\bplayers\b.* from sadara_app/,
    );
  });

  it('changes nothing it inspects', async () => {
    const before = JSON.stringify(report.violations);
    const again = await runPreflight(dirty.migrationUrl);
    expect(JSON.stringify(again.violations)).toBe(before);
  });
});
