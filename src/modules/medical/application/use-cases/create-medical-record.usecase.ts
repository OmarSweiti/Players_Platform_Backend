import { Injectable } from '@nestjs/common';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { MedicalPlayers, requirePlayer } from '../ports/medical-players.port';
import {
  type CreateMedicalRecordInput,
  MedicalRecords,
} from '../ports/medical-records.port';

@Injectable()
export class CreateMedicalRecordUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly medicalRecordRepo: MedicalRecords,
    private readonly players: MedicalPlayers,
  ) {}

  /**
   * The record is the context's tenant's, written by the acting member, about
   * a player of the tenant: another tenant's is not found (0.6.9).
   */
  async execute(
    ctx: AuthorizedTenantContext,
    input: Omit<CreateMedicalRecordInput, 'createdById'>,
  ) {
    // Validate injury date is not in the future
    if (input.injuryDate && input.injuryDate > new Date()) {
      throw new ValidationFailedError('Injury date cannot be in the future', [
        { field: '/injuryDate', code: 'OUT_OF_RANGE' },
      ]);
    }

    // Validate recovery dates
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

    if (
      input.returnToPlayDate &&
      input.injuryDate &&
      input.returnToPlayDate < input.injuryDate
    ) {
      throw new ValidationFailedError(
        'Return to play date cannot be before injury date',
        [{ field: '/returnToPlayDate', code: 'OUT_OF_RANGE' }],
      );
    }

    const createdById = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      await requirePlayer(this.players, tx, ctx, input.playerId);
      return this.medicalRecordRepo.create(tx, ctx, { ...input, createdById });
    });
  }
}
