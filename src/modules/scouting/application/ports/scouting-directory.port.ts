import { NotFoundError } from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

/**
 * The context tenant's players and members, as the scouting use cases name
 * them (0.6.9): a port the module wires to ScoutingDirectoryRepository.
 * Nothing is read or written about a player or a member another tenant's, or
 * no one's.
 */
export abstract class ScoutingDirectory {
  /** Whether `playerId` is a player of the context's tenant. */
  abstract hasPlayer(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<boolean>;

  /** Whether `memberId` is a member of the context's tenant. */
  abstract hasMember(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    memberId: string,
  ): Promise<boolean>;
}

/**
 * Not found unless `playerId` is a player of the context's tenant: another
 * tenant's player answers as no one's does (SR-NFR-SEC-003).
 */
export async function requirePlayer(
  directory: ScoutingDirectory,
  tx: TenantTx,
  ctx: AuthorizedTenantContext,
  playerId: string,
): Promise<void> {
  if (!(await directory.hasPlayer(tx, ctx, playerId))) {
    throw new NotFoundError('Player not found');
  }
}

/** Not found unless `memberId` is a member of the context's tenant. */
export async function requireMember(
  directory: ScoutingDirectory,
  tx: TenantTx,
  ctx: AuthorizedTenantContext,
  memberId: string,
): Promise<void> {
  if (!(await directory.hasMember(tx, ctx, memberId))) {
    throw new NotFoundError('Member not found');
  }
}
