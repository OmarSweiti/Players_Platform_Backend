import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  AuthenticationRequiredError,
  DomainError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import { RateLimiter } from '../../../../common/rate-limit/rate-limiter';
import {
  AuthBootstrap,
  type ProvenIdentity,
} from '../../../../common/tenancy/auth-bootstrap';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import {
  hostOf,
  NoAccountHereError,
  TenantResolver,
} from '../../../../common/tenancy/tenant-resolver';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { mayGrant } from '../../../users/application/role-grants.policy';
import { normalizeEmail } from '../../../users/domain/email';
import { returnUrl } from '../../domain/return-path';
import {
  challengeOf,
  digestOf,
  isSecret,
  newSecret,
  sameDigest,
} from '../../domain/secrets';
import {
  idleExpiryAt,
  lifetimesFrom,
  SESSION_ABSOLUTE_MS,
} from '../../domain/session-lifetime';
import {
  admits,
  needsSecondFactor,
  SECOND_FACTOR_LEVEL,
} from '../assurance.policy';
import {
  IdentityProviderPort,
  type Locale,
  ProviderAnswerRefusedError,
} from '../ports/identity-provider.port';
import { SessionViews } from '../ports/session-views.port';
import { SignInAttempts } from '../ports/sign-in-attempts.port';

/** How long a sign-in may stay in flight, and its pre-auth cookie live: ten minutes. */
export const SIGN_IN_SECONDS = 10 * 60;

/** The request a sign-in arrives on: its host names the tenant (0.5.2). */
type Arrival = Pick<Request, 'hostname'>;

/**
 * A sign-in this API cannot finish: the browser is not the one that began
 * it; its state is unknown, used, or for another tenant; a step-up proved
 * another person; or the second factor a role needs was asked for and not
 * given. `check` names what failed, never a value. The browser starts again.
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

/** What the callback came to (0.5.5; 0.5.8). */
export type SignInOutcome =
  | {
      /** A session: opened, or stepped up and its token replaced. */
      readonly kind: 'signed-in';
      /** The session cookie's value: only its digest is stored. */
      readonly sessionToken: string;
      readonly sessionMaxAgeMs: number;
      /** Where the browser goes: where sign-in began, on this origin. */
      readonly returnTo: string;
    }
  | ({
      /**
       * A member whose role needs a second factor signed in without one: no
       * session; the browser goes back to the provider, asking for it.
       */
      readonly kind: 'second-factor-needed';
    } & SignInStarted);

/** How old an authentication a step-up accepts: none — it is made anew. */
const STEP_UP_MAX_AGE_SECONDS = 0;

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
 *
 * Assurance (0.5.8; SR-AUTH-002). A member whose role is privileged gets no
 * session without a second factor: the callback sends the browser back to
 * the provider asking for level 2, and refuses if it is still not given.
 * `beginStepUp` has a signed-in member authenticate again (`max_age=0`, and
 * level 2 for a privileged role): that attempt is bound to the session the
 * browser holds, and its callback updates that same session — its token
 * replaced, its authentication time and assurance renewed — if, and only if,
 * the same person authenticated, in the same browser.
 */
@Injectable()
export class SignInUseCase {
  constructor(
    private readonly tenants: TenantResolver,
    private readonly bootstrap: AuthBootstrap,
    private readonly provider: IdentityProviderPort,
    private readonly attempts: SignInAttempts,
    private readonly limiter: RateLimiter,
    private readonly transactions: TenantTransactions,
    private readonly views: SessionViews,
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
    /** An invitation's token (isSecret), from its link (0.5.10). */
    invitation?: string;
  }): Promise<SignInStarted> {
    const tenant = await this.tenants.resolve(input.arrival);
    const host = hostOf(input.arrival);
    if (host === null) throw new NoAccountHereError();
    // An invitation's sign-in begins only while it is pending; the provider
    // is told whom to expect, and speaks the invitation's language.
    const invitation =
      input.invitation === undefined ? undefined : digestOf(input.invitation);
    const invited =
      invitation &&
      (await this.bootstrap.pendingInvitation(
        tenant,
        invitation,
        this.clock.now(),
      ));
    if (invitation && !invited) {
      throw new NotFoundError('the invitation is not pending');
    }
    // Sign-ins begun in two tabs share the browser's cookie, so either finishes.
    const preauth = isSecret(input.preauth) ? input.preauth : newSecret();
    const authorizationUrl = await this.startAttempt({
      tenantId: tenant.id,
      redirectUri: new URL(input.callbackPath, `https://${host}`),
      returnTo: input.returnTo,
      binding: preauth,
      locale: invited ? invited.locale : await this.bootstrap.localeOf(tenant),
      ...(invited && invitation
        ? {
            loginHint: invited.email,
            invitation: invitation.toString('base64url'),
          }
        : {}),
    });
    return {
      authorizationUrl,
      preauth,
      preauthMaxAgeMs: SIGN_IN_SECONDS * 1000,
    };
  }

  /**
   * A signed-in member authenticates again (0.5.8): where to send the
   * browser. The attempt is bound to the session the context was minted for.
   */
  async beginStepUp(
    ctx: AuthorizedTenantContext,
    input: { arrival: Arrival; callbackPath: string; returnTo: string },
  ): Promise<URL> {
    if (ctx.actor.kind !== 'USER') {
      throw new AuthenticationRequiredError('only a session steps up');
    }
    const { sessionId } = ctx.actor;
    const view = await this.transactions.withTenantTransaction(ctx, (tx) =>
      this.views.ofContext(tx, ctx),
    );
    const host = hostOf(input.arrival);
    if (!view || host === null) {
      throw new AuthenticationRequiredError('the session is gone');
    }
    return this.startAttempt({
      tenantId: ctx.tenantId,
      redirectUri: new URL(input.callbackPath, `https://${host}`),
      returnTo: input.returnTo,
      binding: view.tokenHash,
      locale: ctx.locale,
      stepUpSessionId: sessionId,
      maxAge: STEP_UP_MAX_AGE_SECONDS,
      ...(needsSecondFactor(view.member.role)
        ? { acrValues: SECOND_FACTOR_LEVEL }
        : {}),
    });
  }

  async complete(input: {
    arrival: Arrival;
    /** The callback's query, as the provider wrote it, without the `?`. */
    query: string;
    /** The pre-auth cookie the browser holds, if any. */
    preauth: unknown;
    /** The session cookie the browser holds, if any: a step-up's binding. */
    session: unknown;
  }): Promise<SignInOutcome> {
    // The browser that began it, and an attempt it began: checked before
    // anything is sent to the provider. A browser that holds neither cookie
    // began nothing, and takes nothing.
    if (!isSecret(input.preauth) && !isSecret(input.session)) {
      throw new SignInRefusedError('preauth');
    }
    const state = new URLSearchParams(input.query).get('state');
    if (!state) throw new SignInRefusedError('state');
    const attempt = await this.attempts.take(state);
    if (!attempt) throw new SignInRefusedError('state');
    const stepUp = attempt.stepUpSessionId !== undefined;
    // A sign-in is bound to the pre-auth cookie; a step-up to the session.
    const bound = stepUp ? input.session : input.preauth;
    if (
      !isSecret(bound) ||
      !sameDigest(
        Buffer.from(attempt.browserBinding, 'base64url'),
        digestOf(bound),
      )
    ) {
      throw new SignInRefusedError(stepUp ? 'session' : 'preauth');
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
      maxAge: attempt.maxAge,
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
    const identity: ProvenIdentity = {
      issuer: proven.issuer,
      subject: proven.subject,
      sid: proven.sid,
      acr: proven.acr,
      amr: proven.amr,
      authTime: proven.authTime,
    };
    const returnTo = returnUrl(
      new URL(attempt.redirectUri).origin,
      attempt.returnTo,
    );
    const sessionToken = newSecret();
    const at = this.clock.now();

    // An invitation's sign-in (0.5.10): its membership is made first, only
    // with its token and the provider's verified address; then the member
    // signs in as any member does, a second factor asked for if the role
    // needs one.
    if (attempt.invitation !== undefined) {
      const accepted = await this.bootstrap.acceptInvitation(
        tenant,
        Buffer.from(attempt.invitation, 'base64url'),
        {
          issuer: proven.issuer,
          subject: proven.subject,
          normalizedEmail:
            proven.email === undefined ? null : normalizeEmail(proven.email),
          emailVerified: proven.emailVerified,
        },
        at,
        mayGrant,
      );
      if (accepted.kind === 'refused') {
        throw new SignInRefusedError(`invitation: ${accepted.check}`);
      }
    }

    if (attempt.stepUpSessionId !== undefined) {
      const steppedUp = await this.bootstrap.stepUpSession(
        tenant,
        { sessionId: attempt.stepUpSessionId, tokenHash: digestOf(bound) },
        identity,
        {
          tokenHash: digestOf(sessionToken),
          at,
          idleExpiresAt: (absolute) => idleExpiryAt(at, absolute),
        },
        admits,
      );
      switch (steppedUp.kind) {
        case 'stepped-up':
          return {
            kind: 'signed-in',
            sessionToken,
            sessionMaxAgeMs:
              steppedUp.absoluteExpiresAt.getTime() - at.getTime(),
            returnTo,
          };
        case 'gone':
          throw new AuthenticationRequiredError('the session is gone');
        case 'another-person':
          throw new SignInRefusedError('identity');
        case 'needs-assurance':
          throw new SignInRefusedError('assurance');
      }
    }

    const opened = await this.bootstrap.openSession(
      tenant,
      identity,
      { tokenHash: digestOf(sessionToken), openedAt: at, ...lifetimesFrom(at) },
      admits,
    );
    switch (opened.kind) {
      case 'opened':
        return {
          kind: 'signed-in',
          sessionToken,
          sessionMaxAgeMs: SESSION_ABSOLUTE_MS,
          returnTo,
        };
      case 'no-member':
        throw new NoAccountHereError();
      case 'needs-assurance':
        // Asked for and still not given: refused, never asked again.
        if (attempt.acrValues === SECOND_FACTOR_LEVEL) {
          throw new SignInRefusedError('assurance');
        }
        return {
          kind: 'second-factor-needed',
          authorizationUrl: await this.startAttempt({
            tenantId: tenant.id,
            redirectUri: new URL(attempt.redirectUri),
            returnTo: attempt.returnTo,
            binding: bound,
            locale: await this.bootstrap.localeOf(tenant),
            acrValues: SECOND_FACTOR_LEVEL,
          }),
          preauth: bound,
          preauthMaxAgeMs: SIGN_IN_SECONDS * 1000,
        };
    }
  }

  /**
   * Keeps a new attempt bound to `binding` — a pre-auth cookie's value, or a
   * session token's digest — and answers where to send the browser.
   */
  private async startAttempt(attempt: {
    tenantId: string;
    redirectUri: URL;
    returnTo: string;
    binding: string | Uint8Array;
    locale: Locale;
    acrValues?: string;
    maxAge?: number;
    stepUpSessionId?: string;
    /** Whom the provider should expect: an invitation's address. */
    loginHint?: string;
    /** An invitation's token digest, base64url (0.5.10). */
    invitation?: string;
  }): Promise<URL> {
    const state = newSecret();
    const nonce = newSecret();
    const codeVerifier = newSecret();
    // First, so that a provider that does not answer leaves nothing behind.
    const authorizationUrl = await this.provider.authorizationUrl({
      redirectUri: attempt.redirectUri,
      state,
      nonce,
      codeChallenge: challengeOf(codeVerifier),
      acrValues: attempt.acrValues,
      maxAge: attempt.maxAge,
      locale: attempt.locale,
      loginHint: attempt.loginHint,
    });
    const bindingDigest =
      typeof attempt.binding === 'string'
        ? digestOf(attempt.binding)
        : Buffer.from(attempt.binding);
    await this.attempts.keep(
      state,
      {
        tenantId: attempt.tenantId,
        redirectUri: attempt.redirectUri.href,
        returnTo: attempt.returnTo,
        nonce,
        codeVerifier,
        browserBinding: bindingDigest.toString('base64url'),
        ...(attempt.acrValues !== undefined
          ? { acrValues: attempt.acrValues }
          : {}),
        ...(attempt.maxAge !== undefined ? { maxAge: attempt.maxAge } : {}),
        ...(attempt.stepUpSessionId !== undefined
          ? { stepUpSessionId: attempt.stepUpSessionId }
          : {}),
        ...(attempt.invitation !== undefined
          ? { invitation: attempt.invitation }
          : {}),
      },
      SIGN_IN_SECONDS,
    );
    return authorizationUrl;
  }
}
