import { Inject, Injectable } from '@nestjs/common';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import { AuthBootstrap } from '../../../../common/tenancy/auth-bootstrap';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import {
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
 */
@Injectable()
export class BackchannelLogoutUseCase {
  constructor(
    private readonly provider: IdentityProviderPort,
    private readonly replays: LogoutTokenReplays,
    private readonly bootstrap: AuthBootstrap,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(logoutToken: string): Promise<{ revoked: number }> {
    let claims;
    try {
      claims = await this.provider.verifyLogoutToken(logoutToken);
    } catch (error) {
      if (error instanceof ProviderAnswerRefusedError) {
        throw new LogoutTokenRefusedError(error.check);
      }
      throw error;
    }
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
      return { revoked };
    } catch (error) {
      // Not honoured: the provider may deliver it again.
      await this.replays.release(claims.issuer, claims.jti);
      throw error;
    }
  }
}
