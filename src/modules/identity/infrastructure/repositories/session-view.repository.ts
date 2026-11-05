import { Injectable } from '@nestjs/common';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import {
  type SessionView,
  SessionViews,
} from '../../application/ports/session-views.port';

/**
 * The context's own session, on the tenant transaction (0.5.6): the session
 * the guard found, its member and its tenant, selecting the fields the view
 * shows and nothing else. `ctx.tenantId` is in every predicate; row-level
 * security is the backstop.
 */
@Injectable()
export class SessionViewRepository implements SessionViews {
  async ofContext(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
  ): Promise<SessionView | null> {
    if (ctx.actor.kind !== 'USER') return null;
    const row = await tx.userSession.findFirst({
      where: {
        id: ctx.actor.sessionId,
        tenantId: ctx.tenantId,
        userId: actingMemberOf(ctx),
      },
      select: {
        tokenHash: true,
        user: {
          select: { id: true, role: true, firstName: true, lastName: true },
        },
        tenant: {
          select: { id: true, slug: true, name: true, defaultLocale: true },
        },
      },
    });
    if (!row) return null;
    const { defaultLocale, ...tenant } = row.tenant;
    return {
      member: row.user,
      tenant: { ...tenant, locale: defaultLocale },
      tokenHash: row.tokenHash,
    };
  }
}
