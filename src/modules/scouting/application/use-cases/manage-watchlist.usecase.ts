import { Injectable } from '@nestjs/common';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import {
  requirePlayer,
  ScoutingDirectory,
} from '../ports/scouting-directory.port';
import { Watchlists } from '../ports/watchlists.port';

/**
 * The acting member's own watchlist, in the context's tenant (0.4.12): of its
 * players only — another tenant's is not found (0.6.9).
 */
@Injectable()
export class ManageWatchlistUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly watchlistRepo: Watchlists,
    private readonly directory: ScoutingDirectory,
  ) {}

  /**
   * Add player to watchlist
   */
  async addToWatchlist(
    ctx: AuthorizedTenantContext,
    playerId: string,
    priority?: string,
    notes?: string,
  ) {
    // Validate priority if provided
    if (priority && !['HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
      throw new ValidationFailedError('Priority must be HIGH, MEDIUM, or LOW', [
        { field: '/priority', code: 'INVALID_VALUE' },
      ]);
    }

    const memberId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      await requirePlayer(this.directory, tx, ctx, playerId);
      return this.watchlistRepo.addToWatchlist(
        tx,
        ctx,
        memberId,
        playerId,
        priority,
        notes,
      );
    });
  }

  /**
   * Remove player from watchlist
   */
  async removeFromWatchlist(ctx: AuthorizedTenantContext, playerId: string) {
    const memberId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.watchlistRepo.removeFromWatchlist(tx, ctx, memberId, playerId),
    );
  }

  /**
   * Get the member's watchlist
   */
  async getWatchlist(ctx: AuthorizedTenantContext) {
    const memberId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.watchlistRepo.getUserWatchlist(tx, ctx, memberId),
    );
  }

  /**
   * Check if player is in watchlist
   */
  async isInWatchlist(ctx: AuthorizedTenantContext, playerId: string) {
    const memberId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      await requirePlayer(this.directory, tx, ctx, playerId);
      return this.watchlistRepo.isInWatchlist(tx, ctx, memberId, playerId);
    });
  }
}
