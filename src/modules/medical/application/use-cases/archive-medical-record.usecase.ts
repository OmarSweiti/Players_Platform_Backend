import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { MedicalRecords } from '../ports/medical-records.port';

/**
 * Archives a medical record (0.4.12): it leaves every ordinary read (DB-57).
 * One already archived, or another tenant's, is not found.
 */
@Injectable()
export class ArchiveMedicalRecordUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly medicalRecordRepo: MedicalRecords,
  ) {}

  async execute(ctx: AuthorizedTenantContext, id: string): Promise<void> {
    await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.medicalRecordRepo.archive(tx, ctx, id),
    );
  }
}
