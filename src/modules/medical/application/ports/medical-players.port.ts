import { NotFoundError } from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

/**
 * The context tenant's players, as the medical use cases name them (0.6.9): a
 * port the module wires to MedicalPlayerRepository. Nothing is read or written
 * about a player another tenant's, or no one's.
 */
export abstract class MedicalPlayers {
  /** Whether `playerId` is a player of the context's tenant. */
  abstract exists(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<boolean>;
}

/**
 * Not found unless `playerId` is a player of the context's tenant: another
 * tenant's player answers as no one's does (SR-NFR-SEC-003).
 */
export async function requirePlayer(
  players: MedicalPlayers,
  tx: TenantTx,
  ctx: AuthorizedTenantContext,
  playerId: string,
): Promise<void> {
  if (!(await players.exists(tx, ctx, playerId))) {
    throw new NotFoundError('Player not found');
  }
}
