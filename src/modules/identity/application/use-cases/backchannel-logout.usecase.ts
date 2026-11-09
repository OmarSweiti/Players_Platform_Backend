import { Inject, Injectable } from '@nestjs/common';
import { AuthBootstrap } from '../../../../common/tenancy/auth-bootstrap';
import {
  DomainError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import {
  type ProviderIdentity,
  SecurityEvents,
  type SecurityRequest,
} from '../../../../infrastructure/audit/security-events';
import {
  checkWordsOf,
  IdentityProviderPort,
  LOGOUT_TOKEN_MAX_AGE_SECONDS,
  ProviderAnswerRefusedError,
} from '../ports/identity-provider.port';
import { LogoutTokenReplays } from '../ports/logout-token-replays.port';

/**
 * How long an honoured logout token is remembered: past the longest it is
 * accepted for (its age bound, with clock tolerance to spare), so that a
 * replay is refused for as long as it could otherwise pass.
 */
export const LOGOUT_TOKEN_REMEMBERED_SECONDS = 2 * LOGOUT_TOKEN_MAX_AGE_SECONDS;

/**
 * A logout token that does not hold, or was already honoured: `400`, as
 * OpenID Connect Back-Channel Logout 1.0 (section 2.8) asks. `check` names
 * what failed, never a value.
 */
export class LogoutTokenRefusedError extends ValidationFailedError {
  constructor(readonly check: string) {
    super(`the logout token was refused: ${check}`, [
      { field: '/logout_token', code: 'INVALID_VALUE' },
    ]);
  }
}

/**
 * Back-channel logout (0.5.7; SR-AUTH-007): the identity provider tells the
 * API that a person signed out there, or that their account was disabled.
 * The token is verified fully — signature, issuer, audience, age, the logout
 * event, `sid` or `sub`, no nonce (the adapter) — then honoured once: a
 * replayed `jti` is refused. The sessions it names end, in every tenant. No
 * session or CSRF token is involved: the token itself is the proof.
 *
 * Each delivery is a security event (0.7.3), with no tenant — its sessions
 * may be in several: honoured, with whom the token named and how many
 * sessions ended, or refused, with the check that failed. An honoured logout
 * whose event cannot be written is not honoured: the provider delivers it
 * again.
 */
@Injectable()
export class BackchannelLogoutUseCase {
  constructor(
    private readonly provider: IdentityProviderPort,
    private readonly replays: LogoutTokenReplays,
    private readonly bootstrap: AuthBootstrap,
    private readonly events: SecurityEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    logoutToken: string,
    request: SecurityRequest,
  ): Promise<{ revoked: number }> {
    let identity: ProviderIdentity | undefined;
    try {
      let claims;
      try {
        claims = await this.provider.verifyLogoutToken(logoutToken);
      } catch (error) {
        if (error instanceof ProviderAnswerRefusedError) {
          throw new LogoutTokenRefusedError(error.check);
        }
        throw error;
      }
      identity = {
        issuer: claims.issuer,
        ...(claims.subject !== undefined ? { subject: claims.subject } : {}),
      };
      const first = await this.replays.claim(
        claims.issuer,
        claims.jti,
        LOGOUT_TOKEN_REMEMBERED_SECONDS,
      );
      if (!first) throw new LogoutTokenRefusedError('logout_token:replayed');
      try {
        const revoked = await this.bootstrap.revokeProviderSessions(
          claims,
          this.clock.now(),
        );
        await this.events.record(
          {
            type: 'backchannel_logout',
            outcome: 'SUCCEEDED',
            identity,
            metadata: { revoked },
          },
          request,
        );
        return { revoked };
      } catch (error) {
        // Not honoured: the provider may deliver it again.
        await this.replays.release(claims.issuer, claims.jti);
        throw error;
      }
    } catch (error) {
      await this.events.record(
        {
          type: 'backchannel_logout',
          outcome: 'REFUSED',
          reason: refusalOf(error),
          identity,
        },
        request,
      );
      throw error;
    }
  }
}

/** Why a delivery was not honoured, as its security event's reason. */
function refusalOf(error: unknown): string {
  if (error instanceof LogoutTokenRefusedError) {
    return checkWordsOf(error.check);
  }
  if (error instanceof DomainError) return error.code;
  return 'internal_error';
}
