import type { PlayerWatchlist } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

/**
 * Members' watchlists, as the use cases need them (0.4.12): a port the module
 * wires to WatchlistRepository. Every method takes the tenant transaction and
 * the verified context first; none takes a tenant id.
 */
export abstract class Watchlists {
  abstract addToWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
    playerId: string,
    priority?: string,
    notes?: string,
  ): Promise<PlayerWatchlist>;

  abstract removeFromWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
    playerId: string,
  ): Promise<PlayerWatchlist>;

  abstract getUserWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
  ): Promise<PlayerWatchlist[]>;

  abstract isInWatchlist(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    userId: string,
    playerId: string,
  ): Promise<boolean>;
}
