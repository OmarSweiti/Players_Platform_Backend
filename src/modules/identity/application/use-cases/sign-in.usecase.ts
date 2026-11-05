import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '../../../../common/errors/domain-error';
import { RateLimiter } from '../../../../common/rate-limit/rate-limiter';
import { AuthBootstrap } from '../../../../common/tenancy/auth-bootstrap';
import {
  hostOf,
  NoAccountHereError,
  TenantResolver,
} from '../../../../common/tenancy/tenant-resolver';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { returnUrl } from '../../domain/return-path';
import {
  challengeOf,
  digestOf,
  isSecret,
  newSecret,
  sameDigest,
} from '../../domain/secrets';
import {
  lifetimesFrom,
  SESSION_ABSOLUTE_MS,
} from '../../domain/session-lifetime';
import {
  IdentityProviderPort,
  ProviderAnswerRefusedError,
} from '../ports/identity-provider.port';
import { SignInAttempts } from '../ports/sign-in-attempts.port';

/** How long a sign-in may stay in flight, and its pre-auth cookie live: ten minutes. */
export const SIGN_IN_SECONDS = 10 * 60;

/** The request a sign-in arrives on: its host names the tenant (0.5.2). */
type Arrival = Pick<Request, 'hostname'>;

/**
 * A sign-in this API cannot finish: the browser is not the one that began
 * it, or its state is unknown, used, or for another tenant. `check` names
 * what failed, never a value. The browser starts again.
 */
export class SignInRefusedError extends DomainError {
  readonly code = 'AUTHENTICATION_REQUIRED';

  constructor(readonly check: string) {
    super(`the sign-in was refused: ${check}`);
  }
}

export interface SignInStarted {
  /** Where the browser goes: the identity provider. */
  readonly authorizationUrl: URL;
  /** The pre-auth cookie's value: the browser's own, or a new one. */
  readonly preauth: string;
  readonly preauthMaxAgeMs: number;
}

export interface SignedIn {
  /** The session cookie's value: only its digest is stored. */
  readonly sessionToken: string;
  readonly sessionMaxAgeMs: number;
  /** Where the browser goes: where sign-in began, on this origin. */
  readonly returnTo: string;
}

/**
 * Sign-in through the API (0.5.5; ADR-0003, SR-CORE-001): the authorization
 * code flow with PKCE, the API as the confidential client.
 *
 * `begin` keeps a one-time attempt — state, nonce, PKCE verifier, the host's
 * tenant, the return path — and binds it to the browser through the pre-auth
 * cookie's digest. `complete` finishes it only in that browser: it takes the
 * attempt once, has the provider prove who signed in, and opens a session for
 * that identity's membership of the host's tenant. Anyone else — no identity,
 * no membership, one inactive or archived — gets "no account here", exactly
 * as an unknown host does, and no session.
 */
@Injectable()
export class SignInUseCase {
  constructor(
    private readonly tenants: TenantResolver,
    private readonly bootstrap: AuthBootstrap,
    private readonly provider: IdentityProviderPort,
    private readonly attempts: SignInAttempts,
    private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async begin(input: {
    arrival: Arrival;
    /** This API's callback path, which every tenant host serves. */
    callbackPath: string;
    /** A path on this origin (isReturnPath). */
    returnTo: string;
    /** The pre-auth cookie the browser holds, if any. */
    preauth: unknown;
  }): Promise<SignInStarted> {
    const tenant = await this.tenants.resolve(input.arrival);
    const host = hostOf(input.arrival);
    if (host === null) throw new NoAccountHereError();
    const locale = await this.bootstrap.localeOf(tenant);

    const state = newSecret();
    const nonce = newSecret();
    const codeVerifier = newSecret();
    const redirectUri = new URL(input.callbackPath, `https://${host}`);
    // First, so that a provider that does not answer leaves nothing behind.
    const authorizationUrl = await this.provider.authorizationUrl({
      redirectUri,
      state,
      nonce,
      codeChallenge: challengeOf(codeVerifier),
      locale,
    });
    // Sign-ins begun in two tabs share the browser's cookie, so either finishes.
    const preauth = isSecret(input.preauth) ? input.preauth : newSecret();
    await this.attempts.keep(
      state,
      {
        tenantId: tenant.id,
        redirectUri: redirectUri.href,
        returnTo: input.returnTo,
        nonce,
        codeVerifier,
        browserBinding: digestOf(preauth).toString('base64url'),
      },
      SIGN_IN_SECONDS,
    );
    return {
      authorizationUrl,
      preauth,
      preauthMaxAgeMs: SIGN_IN_SECONDS * 1000,
    };
  }

  async complete(input: {
    arrival: Arrival;
    /** The callback's query, as the provider wrote it, without the `?`. */
    query: string;
    /** The pre-auth cookie the browser holds, if any. */
    preauth: unknown;
  }): Promise<SignedIn> {
    // The browser that began it, and an attempt it began: checked before
    // anything is sent to the provider.
    if (!isSecret(input.preauth)) throw new SignInRefusedError('preauth');
    const state = new URLSearchParams(input.query).get('state');
    if (!state) throw new SignInRefusedError('state');
    const attempt = await this.attempts.take(state);
    if (!attempt) throw new SignInRefusedError('state');
    if (
      !sameDigest(
        Buffer.from(attempt.browserBinding, 'base64url'),
        digestOf(input.preauth),
      )
    ) {
      throw new SignInRefusedError('preauth');
    }
    const tenant = await this.tenants.resolve(input.arrival);
    if (tenant.id !== attempt.tenantId) throw new SignInRefusedError('tenant');

    const callbackUrl = new URL(attempt.redirectUri);
    callbackUrl.search = input.query;
    const proven = await this.provider.exchange({
      callbackUrl,
      codeVerifier: attempt.codeVerifier,
      expectedState: state,
      expectedNonce: attempt.nonce,
    });
    // Recent authentication (0.5.8) is measured from it.
    if (proven.authTime === undefined) {
      throw new ProviderAnswerRefusedError('id_token:auth_time');
    }
    // The guard counted the address; this counts the account (0.3.8).
    await this.limiter.take(
      'auth',
      `account:${digestOf(`${proven.issuer}\n${proven.subject}`).toString('base64url')}`,
    );

    const sessionToken = newSecret();
    const openedAt = this.clock.now();
    const session = await this.bootstrap.openSession(
      tenant,
      {
        issuer: proven.issuer,
        subject: proven.subject,
        sid: proven.sid,
        acr: proven.acr,
        amr: proven.amr,
        authTime: proven.authTime,
      },
      {
        tokenHash: digestOf(sessionToken),
        openedAt,
        ...lifetimesFrom(openedAt),
      },
    );
    if (!session) throw new NoAccountHereError();
    return {
      sessionToken,
      sessionMaxAgeMs: SESSION_ABSOLUTE_MS,
      returnTo: returnUrl(
        new URL(attempt.redirectUri).origin,
        attempt.returnTo,
      ),
    };
  }
}
