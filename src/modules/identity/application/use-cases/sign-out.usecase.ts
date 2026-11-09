import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import {
  DependencyUnavailableError,
  ForbiddenError,
} from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { hostOf } from '../../../../common/tenancy/tenant-resolver';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { SecurityEvents } from '../../../../infrastructure/audit/security-events';
import { IdentityProviderPort } from '../ports/identity-provider.port';
import { OwnSessions } from '../ports/own-sessions.port';

/** What signing out answers (0.5.7). */
export interface SignedOut {
  /** How many sessions it ended. */
  readonly revoked: number;
  /**
   * Where to send the browser to sign out at the provider too; null when the
   * provider does not answer — the sessions in Sadara are ended regardless.
   */
  readonly endSessionUrl: string | null;
}

/**
 * Signing out (0.5.7; SR-AUTH-007): this session, or every session of the
 * member's (`everywhere`), ended in PostgreSQL first — from the next request
 * they sign nobody in — and then the provider's end-session URL, which
 * returns the browser to this host's start page. The controller clears the
 * cookie. The sign-out's security event (0.7.3) is written in the transaction
 * that ends the sessions.
 */
@Injectable()
export class SignOutUseCase {
  private readonly logger = new Logger(SignOutUseCase.name);

  constructor(
    private readonly tenants: TenantTransactions,
    private readonly sessions: OwnSessions,
    private readonly provider: IdentityProviderPort,
    private readonly events: SecurityEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    input: { arrival: Pick<Request, 'hostname'>; everywhere: boolean },
  ): Promise<SignedOut> {
    if (ctx.actor.kind !== 'USER') {
      throw new ForbiddenError('Only a signed-in member signs out');
    }
    const { sessionId } = ctx.actor;
    const at = this.clock.now();
    const revoked = await this.tenants.withTenantTransaction(
      ctx,
      async (tx) => {
        const ended = input.everywhere
          ? await this.sessions.revokeAll(tx, ctx, 'SIGN_OUT_EVERYWHERE', at)
          : Number(
              await this.sessions.revoke(tx, ctx, sessionId, 'SIGN_OUT', at),
            );
        await this.events.record(
          {
            type: input.everywhere ? 'sign_out_everywhere' : 'sign_out',
            outcome: 'SUCCEEDED',
            tenantHint: ctx.tenantId,
            sessionId,
            metadata: { revoked: ended },
          },
          ctx,
          tx,
        );
        return ended;
      },
    );
    return {
      revoked,
      endSessionUrl: await this.endSessionUrl(ctx, input.arrival),
    };
  }

  private async endSessionUrl(
    ctx: AuthorizedTenantContext,
    arrival: Pick<Request, 'hostname'>,
  ): Promise<string | null> {
    const host = hostOf(arrival);
    if (host === null) return null;
    try {
      const url = await this.provider.endSessionUrl({
        postLogoutRedirectUri: new URL(`https://${host}/`),
        locale: ctx.locale,
      });
      return url.href;
    } catch (error) {
      if (!(error instanceof DependencyUnavailableError)) throw error;
      this.logger.warn('signed out in Sadara; the provider did not answer');
      return null;
    }
  }
}
