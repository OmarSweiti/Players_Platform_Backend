import { Injectable } from '@nestjs/common';
import type { PlayerWatchlist } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { Watchlists } from '../../application/ports/watchlists.port';

/**
 * A member's watchlist, on the tenant transaction (0.4.12): every method takes
 * the transaction and the verified context, and writes `ctx.tenantId` into its
 * predicate. Entries are removed outright until `1.11.4` makes watchlists
 * private and deliberate.
 */
@Injectable()
export class WatchlistRepository implements Watchlists {
  async addToWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
    playerId: string,
    priority?: string,
    notes?: string,
  ): Promise<PlayerWatchlist> {
    return tx.playerWatchlist.upsert({
      where: { userId_playerId: { userId, playerId }, tenantId: ctx.tenantId },
      update: { priority, notes, updatedAt: new Date() },
      create: { userId, tenantId: ctx.tenantId, playerId, priority, notes },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
            currentClub: true,
          },
        },
      },
    });
  }

  async removeFromWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
    playerId: string,
  ): Promise<PlayerWatchlist> {
    return tx.playerWatchlist.delete({
      where: { userId_playerId: { userId, playerId }, tenantId: ctx.tenantId },
    });
  }

  async getUserWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
  ): Promise<PlayerWatchlist[]> {
    return tx.playerWatchlist.findMany({
      where: { userId, tenantId: ctx.tenantId },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
            dateOfBirth: true,
            nationality: true,
            currentClub: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async isInWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
    playerId: string,
  ): Promise<boolean> {
    const count = await tx.playerWatchlist.count({
      where: { userId, playerId, tenantId: ctx.tenantId },
    });
    return count > 0;
  }
}
