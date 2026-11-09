import type { UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { MedicalPlayers } from '../../modules/medical/application/ports/medical-players.port';
import type { MedicalRecords } from '../../modules/medical/application/ports/medical-records.port';
import { ReadMedicalRecordsUseCase } from '../../modules/medical/application/use-cases/read-medical-records.usecase';
import { UpdateMedicalRecordUseCase } from '../../modules/medical/application/use-cases/update-medical-record.usecase';
import type { ScoutingReports } from '../../modules/scouting/application/ports/scouting-reports.port';
import { SubmitScoutingReportUseCase } from '../../modules/scouting/application/use-cases/submit-scouting-report.usecase';
import { ForbiddenError, NotFoundError } from '../errors/domain-error';
import type { AuthorizedTenantContext } from '../tenancy/tenant-context';
import type { TenantTransactions } from '../tenancy/tenant-transaction';

// A policy is evaluated inside the use case (0.6.3; ADR-0005), so it holds
// for a caller that is not a route: here the real use cases, called directly
// — no request, no guard, no route permission — over repositories of the
// test's. The tenant transaction is the test's too: what it refuses (an
// unminted context, another tenant's rows) is proven against PostgreSQL in
// test/authz/object-policies.integration-spec.ts.

const AUTHOR = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const ID = '00000000-0000-4000-8000-0000000000f1';

const as = (userId: string, role: UserRole) =>
  ({
    tenantId: '00000000-0000-4000-8000-000000000001',
    actor: { kind: 'USER', userId, sessionId: 's', role },
    requestId: 'request',
    locale: 'en',
  }) as unknown as AuthorizedTenantContext;

const job = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  actor: { kind: 'SYSTEM', job: 'a-job' },
  requestId: 'request',
  locale: 'en',
} as unknown as AuthorizedTenantContext;

const transactions = {
  withTenantTransaction: (_: unknown, work: (tx: unknown) => unknown) =>
    work({}),
} as unknown as TenantTransactions;

describe('object policies', () => {
  it('policies_apply_to_direct_use_case_calls', async () => {
    // A scout's finished draft.
    const draft = {
      id: ID,
      scoutId: AUTHOR,
      status: 'DRAFT',
      overallRating: 8,
      strengths: 'first touch',
      weaknesses: 'aerial duels',
    };
    const submitReport = vi.fn().mockResolvedValue({
      ...draft,
      status: 'SUBMITTED',
    });
    const reports = {
      findById: vi.fn().mockResolvedValue(draft),
      submitReport,
    } as unknown as ScoutingReports;
    const submit = new SubmitScoutingReportUseCase(transactions, reports);

    // Another scout: refused, though no guard ran. A job: it cannot even see
    // the report. Nothing was written for either.
    await expect(submit.execute(as(OTHER, 'SCOUT'), ID)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(submit.execute(job, ID)).rejects.toEqual(
      new NotFoundError('Scouting report not found'),
    );
    expect(submitReport).not.toHaveBeenCalled();
    // Its author: submitted.
    await expect(submit.execute(as(AUTHOR, 'SCOUT'), ID)).resolves.toEqual(
      expect.objectContaining({ status: 'SUBMITTED' }),
    );
    expect(submitReport).toHaveBeenCalledTimes(1);

    // A confidential medical record, changed directly by an owner — a role
    // the route would refuse for want of medical.update, and the policy
    // refuses on its own; the role is the context's, never an argument.
    const update = vi.fn();
    const records = {
      findById: vi.fn().mockResolvedValue({ id: ID, isConfidential: true }),
      update,
    } as unknown as MedicalRecords;
    // Nothing here names a player.
    const players = { exists: vi.fn() } as unknown as MedicalPlayers;
    await expect(
      new UpdateMedicalRecordUseCase(transactions, records, players).execute(
        as(OTHER, 'OWNER'),
        ID,
        { description: 'changed' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(update).not.toHaveBeenCalled();

    // And a job reading it gets what absence gets.
    await expect(
      new ReadMedicalRecordsUseCase(transactions, records, players).get(
        job,
        ID,
      ),
    ).rejects.toEqual(new NotFoundError('Medical record not found'));
  });
});
