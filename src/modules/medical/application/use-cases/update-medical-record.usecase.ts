import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { medicalRecordPolicy } from '../policies/medical-record.policy';
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

  async execute(
    ctx: AuthorizedTenantContext,
    id: string,
    input: UpdateMedicalRecordInput,
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
      authorizeChange(
        ctx,
        medicalRecordPolicy,
        'update',
        await this.medicalRecordRepo.findById(tx, ctx, id),
        'Medical record not found',
        {
          CONFIDENTIAL: () =>
            new ForbiddenError(
              'Insufficient permissions to update confidential medical records',
            ),
        },
      );
      return this.medicalRecordRepo.update(tx, ctx, id, input);
    });
  }
}
