import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { ScoutingDirectory } from '../../application/ports/scouting-directory.port';

/**
 * The context tenant's players and members, on the tenant transaction
 * (0.6.9): the id alone, with `ctx.tenantId` in each predicate; row-level
 * security is the backstop.
 */
@Injectable()
export class ScoutingDirectoryRepository implements ScoutingDirectory {
  async hasPlayer(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<boolean> {
    const player = await tx.player.findFirst({
      where: { id: playerId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    return player !== null;
  }

  async hasMember(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    memberId: string,
  ): Promise<boolean> {
    const member = await tx.user.findFirst({
      where: { id: memberId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    return member !== null;
  }
}
