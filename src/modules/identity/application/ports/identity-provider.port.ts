import {
  ConflictError,
  DomainError,
  NotFoundError,
} from '../../../../common/errors/domain-error';

/**
 * The identity provider, behind one port (0.5.4; ADR-0002, SR-AUTH-001). The
 * provider proves who someone is, and Sadara decides what they may do: sign-in
 * (0.5.5) sends the browser to `authorizationUrl` and hands back what the
 * provider returned to `exchange`; back-channel logout (0.5.7) checks its
 * token with `verifyLogoutToken`; invitations (0.5.10) and offboarding manage
 * accounts. The Keycloak adapter implements it
 * (infrastructure/keycloak/keycloak-identity-provider.ts).
 */
export abstract class IdentityProviderPort {
  /**
   * Where to send the browser to sign in: the authorization code flow with
   * PKCE (S256), for the callback of the host it came from.
   */
  abstract authorizationUrl(request: AuthorizationRequest): Promise<URL>;

  /**
   * The provider's answer at the callback, checked and exchanged for who
   * signed in. Refused (`ProviderAnswerRefusedError`) unless the response
   * carries the expected state and issuer and the ID token holds: signed by
   * one of the issuer's current keys, from the allowlisted issuer, for this
   * client, unexpired, and with the nonce this sign-in sent.
   */
  abstract exchange(callback: CallbackAnswer): Promise<VerifiedSignIn>;

  /** A back-channel logout token's subject and session, once it holds. */
  abstract verifyLogoutToken(jwt: string): Promise<LogoutClaims>;

  /**
   * Where to send the browser to sign out at the provider too (0.5.7), and be
   * returned to `postLogoutRedirectUri`, one the provider has registered.
   * Sadara keeps no ID token, so the client identifies itself instead.
   */
  abstract endSessionUrl(request: EndSessionRequest): Promise<URL>;

  /**
   * A new account for `email`, which the person completes through
   * `requiredActions`. Its subject is the identity's (0.5.3).
   */
  abstract createAccount(
    email: string,
    locale: Locale,
    requiredActions: readonly RequiredAction[],
  ): Promise<{ subject: string }>;

  /**
   * The account the provider has for `email`, if any (0.5.9): how a
   * provisioning run that stopped part-way finds what it already made.
   */
  abstract findAccount(email: string): Promise<{ subject: string } | null>;

  /** Sends the account's pending required actions to its address. */
  abstract sendSetupEmail(subject: string): Promise<void>;

  /** Disables the account and ends its sessions at the provider. */
  abstract disableAccount(subject: string): Promise<void>;
}

export type Locale = 'ar' | 'en';

/**
 * How old a back-channel logout token may be (0.5.7). OpenID Connect
 * Back-Channel Logout 1.0 asks for short-lived tokens; a bounded age bounds
 * how long a token's `jti` must be remembered to refuse its replay.
 */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 5 * 60;

/** What a person completes at the provider before their account is ready. */
export type RequiredAction = 'VERIFY_EMAIL' | 'SET_PASSWORD' | 'CONFIGURE_OTP';

export interface AuthorizationRequest {
  /** This host's callback, one the provider has registered (0.5.1). */
  readonly redirectUri: URL;
  readonly state: string;
  readonly nonce: string;
  /** BASE64URL(SHA-256(code_verifier)) (RFC 7636). */
  readonly codeChallenge: string;
  readonly loginHint?: string;
  /** The assurance a step-up asks for (0.5.8). */
  readonly acrValues?: string;
  /**
   * How many seconds ago the person may have last authenticated (OpenID
   * Connect Core 1.0, 3.1.2.1): 0 has them authenticate again (0.5.8).
   */
  readonly maxAge?: number;
  readonly locale: Locale;
}

export interface CallbackAnswer {
  /** The URL the browser came back to, its query as the provider wrote it. */
  readonly callbackUrl: URL;
  readonly codeVerifier: string;
  readonly expectedState: string;
  readonly expectedNonce: string;
  /** The `max_age` the request sent, which `auth_time` is checked against. */
  readonly maxAge?: number;
}

/** Who signed in, as the ID token proved it. Nothing else is kept. */
export interface VerifiedSignIn {
  readonly issuer: string;
  readonly subject: string;
  /** The provider's session, which back-channel logout names (0.5.7). */
  readonly sid?: string;
  readonly acr?: string;
  readonly amr: readonly string[];
  readonly authTime?: Date;
  readonly email?: string;
  readonly emailVerified: boolean;
}

/**
 * A verified back-channel logout token (0.5.4; 0.5.7): whose sessions end,
 * and what identifies the token itself, so that it is honoured once.
 */
export interface LogoutClaims {
  readonly issuer: string;
  /** The token's own id: a replay repeats it (0.5.7). */
  readonly jti: string;
  readonly issuedAt: Date;
  readonly subject?: string;
  readonly sid?: string;
}

export interface EndSessionRequest {
  /** This host's start page, which the provider has registered (0.5.1). */
  readonly postLogoutRedirectUri: URL;
  readonly locale: Locale;
}

/**
 * The provider's answer does not prove who signed in, or a logout token does
 * not hold. `check` names the check that failed, never a token or a claim's
 * value; sign-in (0.5.5) answers with a refusal and records it (0.7.3).
 */
export class ProviderAnswerRefusedError extends DomainError {
  readonly code = 'AUTHENTICATION_REQUIRED';

  constructor(readonly check: string) {
    super(`the identity provider's answer was refused: ${check}`);
  }
}

/** The provider already has an account for this address. */
export class AccountExistsError extends ConflictError {
  constructor() {
    super('the identity provider already has an account for this address');
  }
}

/** The provider has no account with this subject. */
export class AccountNotFoundError extends NotFoundError {
  constructor() {
    super('the identity provider has no account with this subject');
  }
}
