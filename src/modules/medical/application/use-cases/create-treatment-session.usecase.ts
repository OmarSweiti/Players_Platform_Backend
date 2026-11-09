import { Injectable } from '@nestjs/common';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { MedicalPlayers, requirePlayer } from '../ports/medical-players.port';
import { MedicalRecords, requireRecord } from '../ports/medical-records.port';
import {
  type CreateTreatmentSessionInput,
  TreatmentSessions,
} from '../ports/treatment-sessions.port';

@Injectable()
export class CreateTreatmentSessionUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly treatmentSessionRepo: TreatmentSessions,
    private readonly players: MedicalPlayers,
    private readonly records: MedicalRecords,
  ) {}

  /**
   * The session is the context's tenant's, conducted by the acting member, for
   * a player of the tenant, under one of its records if it names one: another
   * tenant's player or record is not found (0.6.9).
   */
  async execute(
    ctx: AuthorizedTenantContext,
    input: Omit<CreateTreatmentSessionInput, 'conductedBy'>,
  ) {
    // Validate session date is not in the past for scheduled sessions
    if (input.status === 'SCHEDULED' && input.sessionDate < new Date()) {
      throw new ValidationFailedError('Cannot schedule a session in the past', [
        { field: '/sessionDate', code: 'OUT_OF_RANGE' },
      ]);
    }

    // Validate duration
    if (input.duration && (input.duration < 15 || input.duration > 480)) {
      throw new ValidationFailedError(
        'Session duration must be between 15 and 480 minutes',
        [{ field: '/duration', code: 'OUT_OF_RANGE' }],
      );
    }

    const conductedBy = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      await requirePlayer(this.players, tx, ctx, input.playerId);
      if (input.medicalRecordId !== undefined) {
        await requireRecord(this.records, tx, ctx, input.medicalRecordId);
      }
      return this.treatmentSessionRepo.create(tx, ctx, {
        ...input,
        conductedBy,
      });
    });
  }
}
