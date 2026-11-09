import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../common/errors/domain-error';
import { type Page, paginate } from '../../../../common/pagination/paginate';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { SecurityEvents } from '../../../../infrastructure/audit/security-events';
import { OwnSessions, type SessionSummary } from '../ports/own-sessions.port';

/** A session in the member's list: which one is this browser's. */
export interface ListedSession extends SessionSummary {
  readonly current: boolean;
}

/**
 * A member's own sessions (0.5.7): the live ones, newest first, and ending
 * one. Only the member's own are ever found: another member's session, in
 * this tenant or any other, is not found, exactly like one that never
 * existed. Ending one is a security event (0.7.3), in its transaction — and
 * so is a refusal, since asking to end a session that is not one's own may
 * be an attempt on another's.
 */
@Injectable()
export class OwnSessionsUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly sessions: OwnSessions,
    private readonly events: SecurityEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(
    ctx: AuthorizedTenantContext,
    query: { limit: number; cursor?: string },
  ): Promise<Page<ListedSession>> {
    const current = ctx.actor.kind === 'USER' ? ctx.actor.sessionId : null;
    const at = this.clock.now();
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      paginate(
        {
          ...query,
          // A cursor is this member's, for this list: another's is refused.
          scope: {
            tenantId: ctx.tenantId,
            filters: { member: actingMemberOf(ctx) },
            sort: 'createdAt.desc',
          },
        },
        async (args) =>
          (await this.sessions.list(tx, ctx, at, args)).map((session) => ({
            ...session,
            current: session.id === current,
          })),
      ),
    );
  }

  /** Ends one of the member's sessions; whether it was this browser's. */
  async revoke(
    ctx: AuthorizedTenantContext,
    sessionId: string,
  ): Promise<{ wasCurrent: boolean }> {
    const ended = await this.tenants.withTenantTransaction(ctx, async (tx) => {
      const revoked = await this.sessions.revoke(
        tx,
        ctx,
        sessionId,
        'REVOKED_BY_MEMBER',
        this.clock.now(),
      );
      await this.events.record(
        {
          type: 'session_revoked',
          tenantHint: ctx.tenantId,
          sessionId,
          metadata: {
            revokeReason: 'REVOKED_BY_MEMBER',
            ...(ctx.actor.kind === 'USER'
              ? { actorSessionId: ctx.actor.sessionId }
              : {}),
          },
          ...(revoked
            ? { outcome: 'SUCCEEDED' as const }
            : { outcome: 'REFUSED' as const, reason: 'not_found' }),
        },
        ctx,
        tx,
      );
      return revoked;
    });
    if (!ended) throw new NotFoundError('No such session of yours');
    return {
      wasCurrent:
        ctx.actor.kind === 'USER' && ctx.actor.sessionId === sessionId,
    };
  }
}
