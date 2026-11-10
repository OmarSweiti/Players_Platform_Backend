import { randomBytes } from 'node:crypto';
import type { PrismaClient, Tenant, User } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConfidentialClass } from '../../src/common/policy/confidential-class';
import {
  ALLOW,
  authorizeRead,
  definePolicy,
  deny,
  disclosedClasses,
} from '../../src/common/policy/policy';
import { confidential } from '../../src/common/policy/projection';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { id, instant } from '../../src/common/validation/schemas';
import { AccessAudit } from '../../src/infrastructure/audit/access-audit';
import { AuditService } from '../../src/infrastructure/audit/audit.service';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  createIsolatedSchema,
  type IsolatedSchema,
  prismaFor,
} from '../harness/db';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
  memberContext,
  runPrisma,
} from '../harness/fixtures';

// Access audit for confidential reads (0.7.4; I-5). A medical record is read
// as a use case reads one — in its tenant transaction, authorised by its
// policy, its medical fields disclosed only to the clinician who recorded it
// — and released through the access audit: the access is recorded, in the
// same transaction, before the record is returned, and if it cannot be, the
// record is withheld. Two tenants, real PostgreSQL 18, as the runtime role.

const suffix = () => randomBytes(4).toString('hex');

/** A medical record's response: its medical fields marked. */
const MedicalRecordResponse = z.strictObject({
  id,
  playerId: id,
  createdAt: instant,
  injuryType: confidential('MEDICAL', z.string()),
  description: confidential('MEDICAL', z.string()).nullable(),
  treatment: confidential('MEDICAL', z.string()).nullable(),
});

interface MedicalRecordView {
  readonly id: string;
  readonly playerId: string;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly injuryType?: string;
  readonly description?: string | null;
  readonly treatment?: string | null;
}

/** The clinician who recorded it reads its medical fields; the route's members read the rest. */
const recordPolicy = definePolicy<never, MedicalRecordView>(
  { read: () => ALLOW },
  {
    MEDICAL: (member, record) =>
      member.userId === record.createdById ? ALLOW : deny('UNRELATED'),
  },
);

/** The medical grant, as the stored matrix gives it to the MEDICAL role (0.6.4). */
const grantOf = (member: User): ReadonlySet<ConfidentialClass> =>
  new Set(member.role === 'MEDICAL' ? (['MEDICAL'] as const) : []);

/** Reads a medical record as a use case does, and releases it through the access audit. */
function readMedicalRecord(
  prisma: PrismaClient,
  ctx: AuthorizedTenantContext,
  member: User,
  recordId: string,
  audit: AccessAudit = new AccessAudit(new AuditService()),
) {
  return new TenantTransactions(prisma).withTenantTransaction(
    ctx,
    async (tx) => {
      const loaded = await tx.medicalRecord.findFirst({
        where: { id: recordId, tenantId: ctx.tenantId, deletedAt: null },
        select: {
          id: true,
          playerId: true,
          createdById: true,
          createdAt: true,
          injuryType: true,
          description: true,
          treatment: true,
        },
      });
      const record = authorizeRead(
        ctx,
        recordPolicy,
        loaded,
        'Medical record not found',
      );
      return audit.release(
        tx,
        ctx,
        { action: 'medical_record.read', id: record.id },
        { schema: MedicalRecordResponse, value: record },
        disclosedClasses(ctx, recordPolicy, record, grantOf(member)),
      );
    },
  );
}

/** A medical record of a new player, recorded by `clinician`. */
async function recordBy(
  tenant: Tenant,
  clinician: User,
  prisma: PrismaClient = runPrisma(),
) {
  const player = await createPlayer(tenant, prisma);
  return asTenant(
    tenant.id,
    (tx) =>
      tx.medicalRecord.create({
        data: {
          tenantId: tenant.id,
          playerId: player.id,
          createdById: clinician.id,
          injuryType: `Synthetic strain ${suffix()}`,
          description: `Synthetic finding ${suffix()}`,
          treatment: null,
        },
      }),
    prisma,
  );
}

/** Every access event about `recordId`, as the tenant reads its audit. */
function accessEventsOf(
  tenant: Tenant,
  recordId: string,
  prisma: PrismaClient = runPrisma(),
) {
  return asTenant(
    tenant.id,
    (tx) =>
      tx.auditLog.findMany({
        where: { entityId: recordId, action: 'medical_record.read' },
        orderBy: { createdAt: 'asc' },
      }),
    prisma,
  );
}

describe('access audit for confidential reads', () => {
  let tenants: Tenant[];
  const clinicians: User[] = [];
  const colleagues: User[] = [];
  const coaches: User[] = [];

  beforeAll(async () => {
    tenants = [await createTenant(), await createTenant()];
    for (const tenant of tenants) {
      clinicians.push(await createMember(tenant, 'MEDICAL'));
      colleagues.push(await createMember(tenant, 'MEDICAL'));
      coaches.push(await createMember(tenant, 'COACH'));
    }
  });

  it('reading_a_medical_record_leaves_an_access_event', async () => {
    for (const [i, tenant] of tenants.entries()) {
      const clinician = clinicians[i];
      const record = await recordBy(tenant, clinician);

      // The clinician who recorded it reads it: the medical fields leave,
      // and one access event says who read which record's which class.
      const ctx = memberContext(clinician, { address: '203.0.113.20' });
      expect(
        await readMedicalRecord(runPrisma(), ctx, clinician, record.id),
      ).toEqual({
        id: record.id,
        playerId: record.playerId,
        createdAt: record.createdAt,
        injuryType: record.injuryType,
        description: record.description,
        treatment: null,
      });
      const [event, ...more] = await accessEventsOf(tenant, record.id);
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        tenantId: tenant.id,
        action: 'medical_record.read',
        entityType: 'MedicalRecord',
        entityId: record.id,
        actorType: 'USER',
        userId: clinician.id,
        actorRole: 'MEDICAL',
        actorSessionId:
          ctx.actor.kind === 'USER' ? ctx.actor.sessionId : undefined,
        requestId: ctx.requestId,
        ipAddress: '203.0.113.20',
        outcome: 'SUCCEEDED',
        schemaVersion: 2,
        oldValues: null,
        newValues: { classes: ['MEDICAL'] },
      });
      // Identifiers, never the content.
      const kept = JSON.stringify(event);
      for (const content of [record.injuryType, record.description ?? '']) {
        expect(kept).not.toContain(content);
      }

      // A medical colleague holds the grant, and a coach does not; neither
      // is disclosed the record's medical fields, so neither read releases
      // one, and neither leaves an access event.
      for (const reader of [colleagues[i], coaches[i]]) {
        const read = await readMedicalRecord(
          runPrisma(),
          memberContext(reader),
          reader,
          record.id,
        );
        expect(read).toEqual({
          id: record.id,
          playerId: record.playerId,
          createdAt: record.createdAt,
        });
      }
      expect(await accessEventsOf(tenant, record.id)).toHaveLength(1);

      // The other tenant's members never see the record, nor its events.
      const other = tenants[1 - i];
      await expect(
        readMedicalRecord(
          runPrisma(),
          memberContext(clinicians[1 - i]),
          clinicians[1 - i],
          record.id,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await accessEventsOf(other, record.id)).toEqual([]);
    }
  });

  describe("in a schema of the test's own", () => {
    let isolated: IsolatedSchema;
    let db: ReturnType<typeof prismaFor>;
    let migrator: Client;
    let schemaTenants: Tenant[];
    const schemaClinicians: User[] = [];
    const schemaColleagues: User[] = [];

    // A schema of its own, so that the fault touches no other test's audit.
    beforeAll(async () => {
      isolated = await createIsolatedSchema();
      db = prismaFor(isolated.url);
      schemaTenants = [
        await createTenant({ prisma: db.prisma }),
        await createTenant({ prisma: db.prisma }),
      ];
      for (const tenant of schemaTenants) {
        schemaClinicians.push(await createMember(tenant, 'MEDICAL', db.prisma));
        schemaColleagues.push(await createMember(tenant, 'MEDICAL', db.prisma));
      }
      const { connectionString, options } = databaseConnectionOf(
        isolated.migrationUrl,
      );
      migrator = new Client({ connectionString, options });
      await migrator.connect();
      await migrator.query(`
        CREATE FUNCTION fail_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected fault: the audit insert fails'; END $$;
        CREATE TRIGGER audit_logs_injected_fault BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION fail_audit_insert();`);
    });

    afterAll(async () => {
      await migrator?.end();
      await db?.close();
      await isolated?.drop();
    });

    it('a_failed_access_audit_withholds_the_data', async () => {
      for (const [i, tenant] of schemaTenants.entries()) {
        const clinician = schemaClinicians[i];
        const record = await recordBy(tenant, clinician, db.prisma);

        // The access event cannot be written: the read fails, and the
        // record's medical fields are never returned.
        let released: unknown;
        await expect(
          readMedicalRecord(
            db.prisma,
            memberContext(clinician),
            clinician,
            record.id,
          ).then((value) => (released = value)),
        ).rejects.toThrow(/injected fault/);
        expect(released).toBeUndefined();
        expect(await accessEventsOf(tenant, record.id, db.prisma)).toEqual([]);

        // A read that releases nothing confidential needs no event: it is
        // answered, the fault notwithstanding.
        expect(
          await readMedicalRecord(
            db.prisma,
            memberContext(schemaColleagues[i]),
            schemaColleagues[i],
            record.id,
          ),
        ).toEqual({
          id: record.id,
          playerId: record.playerId,
          createdAt: record.createdAt,
        });
      }

      // The fault lifted: the same read is released, and recorded.
      await migrator.query(
        'DROP TRIGGER audit_logs_injected_fault ON audit_logs',
      );
      const [tenant] = schemaTenants;
      const record = await recordBy(tenant, schemaClinicians[0], db.prisma);
      expect(
        await readMedicalRecord(
          db.prisma,
          memberContext(schemaClinicians[0]),
          schemaClinicians[0],
          record.id,
        ),
      ).toHaveProperty('injuryType', record.injuryType);
      expect(await accessEventsOf(tenant, record.id, db.prisma)).toHaveLength(
        1,
      );
    });
  });
});
