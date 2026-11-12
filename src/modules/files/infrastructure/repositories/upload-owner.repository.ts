import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { UPLOAD_KINDS } from '../../domain/upload-kinds';
import {
  UploadOwners,
  type UploadOwnerView,
} from '../../application/ports/upload-owners.port';
import type { UploadOwnerRef } from '../../application/ports/upload-records.port';

/**
 * The owners uploads are for, in the context's tenant, on the tenant
 * transaction (0.8.3): the id alone, with `ctx.tenantId` in the predicate;
 * row-level security is the backstop. A kind's owner is looked up where it
 * lives — a player among the players.
 */
@Injectable()
export class UploadOwnerRepository implements UploadOwners {
  async find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    owner: UploadOwnerRef,
  ): Promise<UploadOwnerView | null> {
    switch (UPLOAD_KINDS[owner.kind].owner) {
      case 'player': {
        const player = await tx.player.findFirst({
          where: { id: owner.id, tenantId: ctx.tenantId },
          select: { id: true },
        });
        return player === null ? null : { kind: owner.kind, id: player.id };
      }
    }
  }
}
