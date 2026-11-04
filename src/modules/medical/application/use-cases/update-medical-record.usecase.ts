import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import {
  MedicalRecords,
  type UpdateMedicalRecordInput,
} from '../ports/medical-records.port';

@Injectable()
export class UpdateMedicalRecordUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly medicalRecordRepo: MedicalRecords,
  ) {}

  /** `memberRole` is the signed-in member's, from the session. */
  async execute(
    ctx: AuthorizedTenantContext,
    id: string,
    input: UpdateMedicalRecordInput,
    memberRole: string,
  ) {
    // Validate dates if updating
    if (
      input.recoveryDate &&
      input.injuryDate &&
      input.recoveryDate < input.injuryDate
    ) {
      throw new ValidationFailedError(
        'Recovery date cannot be before injury date',
        [{ field: '/recoveryDate', code: 'OUT_OF_RANGE' }],
      );
    }

    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const record = await this.medicalRecordRepo.findById(tx, ctx, id);
      if (!record) {
        throw new NotFoundError('Medical record not found');
      }

      // Only medical staff can update confidential records
      if (
        record.isConfidential &&
        !['MEDICAL', 'PHYSIOTHERAPIST', 'SUPER_ADMIN'].includes(memberRole)
      ) {
        throw new ForbiddenError(
          'Insufficient permissions to update confidential medical records',
        );
      }

      return this.medicalRecordRepo.update(tx, ctx, id, input);
    });
  }
}
