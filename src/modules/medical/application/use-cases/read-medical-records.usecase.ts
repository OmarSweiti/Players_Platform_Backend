import { Injectable } from '@nestjs/common';
import { authorizeRead } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { medicalRecordPolicy } from '../policies/medical-record.policy';
import { MedicalPlayers, requirePlayer } from '../ports/medical-players.port';
import { MedicalRecords } from '../ports/medical-records.port';

type Page = { skip?: number; take?: number };

/**
 * The medical record reads (0.4.12): each in one tenant transaction, as the
 * context's tenant, live records only. A player's reads name a player of the
 * tenant, or are not found (0.6.9). What a reader may see of a record is
 * `0.6.8`'s.
 */
@Injectable()
export class ReadMedicalRecordsUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly medicalRecordRepo: MedicalRecords,
    private readonly players: MedicalPlayers,
  ) {}

  async list(
    ctx: AuthorizedTenantContext,
    filters: {
      playerId?: string;
      injuryType?: string;
      isConfidential?: boolean;
    },
    page: Page,
  ) {
    const { records } = await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.medicalRecordRepo.findAll(tx, ctx, filters, page),
    );
    return records;
  }

  async forPlayer(
    ctx: AuthorizedTenantContext,
    playerId: string,
    filters: { injuryType?: string; isConfidential?: boolean },
    page: Page,
  ) {
    const { records } = await this.tenants.withTenantTransaction(
      ctx,
      async (tx) => {
        await requirePlayer(this.players, tx, ctx, playerId);
        return this.medicalRecordRepo.findByPlayer(
          tx,
          ctx,
          playerId,
          filters,
          page,
        );
      },
    );
    return records;
  }

  get(ctx: AuthorizedTenantContext, id: string) {
    return this.tenants.withTenantTransaction(ctx, async (tx) =>
      authorizeRead(
        ctx,
        medicalRecordPolicy,
        await this.medicalRecordRepo.findById(tx, ctx, id),
        'Medical record not found',
      ),
    );
  }

  activeInjuries(ctx: AuthorizedTenantContext, playerId: string) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      await requirePlayer(this.players, tx, ctx, playerId);
      return this.medicalRecordRepo.getActiveInjuries(tx, ctx, playerId);
    });
  }

  injuryHistory(ctx: AuthorizedTenantContext, playerId: string) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      await requirePlayer(this.players, tx, ctx, playerId);
      return this.medicalRecordRepo.getPlayerInjuryHistory(tx, ctx, playerId);
    });
  }
}
