import type { Player, Tenant, User } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  NotFoundError,
} from '../../src/common/errors/domain-error';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { UpdateMedicalRecordUseCase } from '../../src/modules/medical/application/use-cases/update-medical-record.usecase';
import { MedicalRecordRepository } from '../../src/modules/medical/infrastructure/repositories/medical-record.repository';
import { SubmitScoutingReportUseCase } from '../../src/modules/scouting/application/use-cases/submit-scouting-report.usecase';
import { ScoutingReportRepository } from '../../src/modules/scouting/infrastructure/repositories/scouting-report.repository';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
  memberContext,
  runPrisma,
  testContext,
} from '../harness/fixtures';

// Object policies (0.6.3) hold for a use case called directly: the real use
// cases, repositories and tenant transaction, as the runtime role against
// PostgreSQL, with two tenants — no request, no guard, no route permission.
// The context is the only thing a caller hands over, and it is minted.

describe('object policies, called directly', () => {
  let a: Tenant;
  let b: Tenant;
  let author: User;
  let colleague: User;
  let scoutOfB: User;
  let owner: User;
  let doctor: User;
  let player: Player;
  const tenants = () => new TenantTransactions(runPrisma());

  beforeAll(async () => {
    [a, b] = [await createTenant(), await createTenant()];
    [author, colleague, owner, doctor, scoutOfB] = [
      await createMember(a, 'SCOUT'),
      await createMember(a, 'SCOUT'),
      await createMember(a, 'OWNER'),
      await createMember(a, 'MEDICAL'),
      await createMember(b, 'SCOUT'),
    ];
    player = await createPlayer(a);
  });

  const statusOf = (id: string) =>
    asTenant(a.id, async (tx) => {
      const report = await tx.scoutingReport.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      return report.status;
    });

  it('a_report_is_submitted_by_its_author_however_the_use_case_is_called', async () => {
    const reports = new ScoutingReportRepository();
    const draft = await tenants().withTenantTransaction(
      memberContext(author),
      (tx) =>
        reports.create(tx, memberContext(author), {
          scoutId: author.id,
          playerId: player.id,
          overallRating: 7,
          strengths: 'first touch',
          weaknesses: 'aerial duels',
        }),
    );
    const submit = new SubmitScoutingReportUseCase(tenants(), reports);

    // A colleague in the same tenant: the policy refuses. Another tenant's
    // scout and a job: not found, as absence is. The draft is untouched.
    await expect(
      submit.execute(memberContext(colleague), draft.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      submit.execute(memberContext(scoutOfB), draft.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      submit.execute(testContext(a.id), draft.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await statusOf(draft.id)).toBe('DRAFT');

    // Its author: submitted.
    await submit.execute(memberContext(author), draft.id);
    expect(await statusOf(draft.id)).toBe('SUBMITTED');
  });

  it('a_confidential_record_is_changed_by_medical_staff_however_the_use_case_is_called', async () => {
    const records = new MedicalRecordRepository();
    const record = await tenants().withTenantTransaction(
      memberContext(doctor),
      (tx) =>
        records.create(tx, memberContext(doctor), {
          playerId: player.id,
          createdById: doctor.id,
          injuryType: 'Hamstring strain',
          isConfidential: true,
        }),
    );
    const update = new UpdateMedicalRecordUseCase(tenants(), records);
    const descriptionOf = () =>
      asTenant(a.id, async (tx) => {
        const row = await tx.medicalRecord.findUniqueOrThrow({
          where: { id: record.id },
          select: { description: true },
        });
        return row.description;
      });

    // The owner, whom no route would admit for want of medical.update: the
    // policy refuses on its own, from the role in the context.
    await expect(
      update.execute(memberContext(owner), record.id, {
        description: 'changed by the owner',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await descriptionOf()).toBeNull();

    // Medical staff: changed.
    await update.execute(memberContext(doctor), record.id, {
      description: 'changed by medical staff',
    });
    expect(await descriptionOf()).toBe('changed by medical staff');
  });
});
