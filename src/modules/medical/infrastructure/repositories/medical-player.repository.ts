import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { MedicalPlayers } from '../../application/ports/medical-players.port';

/**
 * The context tenant's players, on the tenant transaction (0.6.9): the id
 * alone, with `ctx.tenantId` in the predicate; row-level security is the
 * backstop.
 */
@Injectable()
export class MedicalPlayerRepository implements MedicalPlayers {
  async exists(
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
}
