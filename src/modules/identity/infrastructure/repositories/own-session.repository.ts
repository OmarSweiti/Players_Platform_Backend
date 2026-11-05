import { Injectable } from '@nestjs/common';
import type { SessionRevocation } from '@prisma/client';
import {
  KEYSET_ORDER,
  keysetWhere,
} from '../../../../common/pagination/keyset';
import type { KeysetArgs } from '../../../../common/pagination/paginate';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import {
  OwnSessions,
  type SessionSummary,
} from '../../application/ports/own-sessions.port';

/**
 * The member's own sessions, on the tenant transaction (0.5.7). Every
 * predicate names `ctx.tenantId` and the acting member; row-level security is
 * the backstop. A revocation ends only a session not already ended, and moves
 * its revision.
 */
@Injectable()
export class OwnSessionRepository implements OwnSessions {
  list(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    at: Date,
    { take, after }: KeysetArgs,
  ): Promise<SessionSummary[]> {
    return tx.userSession.findMany({
      where: {
        AND: [
          {
            tenantId: ctx.tenantId,
            userId: actingMemberOf(ctx),
            revokedAt: null,
            idleExpiresAt: { gt: at },
            absoluteExpiresAt: { gt: at },
          },
          keysetWhere(after),
        ],
      },
      orderBy: [...KEYSET_ORDER],
      take,
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        idleExpiresAt: true,
        absoluteExpiresAt: true,
        acr: true,
      },
    });
  }

  async revoke(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    sessionId: string,
    reason: SessionRevocation,
    at: Date,
  ): Promise<boolean> {
    const { count } = await tx.userSession.updateMany({
      where: {
        id: sessionId,
        tenantId: ctx.tenantId,
        userId: actingMemberOf(ctx),
        revokedAt: null,
      },
      data: { revokedAt: at, revokeReason: reason, revision: { increment: 1 } },
    });
    return count === 1;
  }

  async revokeAll(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    reason: SessionRevocation,
    at: Date,
  ): Promise<number> {
    const { count } = await tx.userSession.updateMany({
      where: {
        tenantId: ctx.tenantId,
        userId: actingMemberOf(ctx),
        revokedAt: null,
      },
      data: { revokedAt: at, revokeReason: reason, revision: { increment: 1 } },
    });
    return count;
  }
}
