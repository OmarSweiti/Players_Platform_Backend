import { Logger } from '@nestjs/common';
import {
  createRemoteJWKSet,
  errors as jose,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import * as oidc from 'openid-client';
import { DependencyUnavailableError } from '../../../../common/errors/domain-error';
import {
  ProviderAnswerRefusedError,
  type AuthorizationRequest,
  type CallbackAnswer,
  type EndSessionRequest,
  LOGOUT_TOKEN_MAX_AGE_SECONDS,
  type LogoutClaims,
  type VerifiedSignIn,
} from '../../application/ports/identity-provider.port';

/** How long one request to the provider may take: discovery, a token, its keys. */
const TIMEOUT_SECONDS = 10;

/**
 * The ID token's signature algorithm, pinned: the realm signs with RS256
 * (Keycloak's default), and a token in any other — `none`, an HMAC keyed with
 * the client secret — is refused.
 */
const ID_TOKEN_ALGORITHM = 'RS256';

/**
 * How far an ID token's `iat` may be ahead of this clock: the library's own
 * clock tolerance. The library checks `exp` against it, but not a token
 * issued in the future; this adapter refuses that too.
 */
const CLOCK_TOLERANCE_SECONDS = 30;

/** A logout token is signed with the issuer's keys, never a shared secret. */
const LOGOUT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
];
const BACKCHANNEL_LOGOUT_EVENT =
  'http://schemas.openid.net/event/backchannel-logout';

export interface ClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One OpenID Connect client of one issuer (0.5.4), through openid-client, an
 * OpenID Certified relying party (its README, "Certification"). The issuer's
 * metadata comes from discovery on first use, never at boot, and must name
 * the configured issuer exactly. Every ID token's signature is checked against
 * the issuer's published keys (`enableNonRepudiationChecks`): the library
 * otherwise trusts TLS for it, and the local Keycloak has none. The key set is
 * the library's cache: refetched after five minutes, or after one minute when
 * a token names a key it does not hold.
 */
export class OidcRelyingParty {
  private configuration?: Promise<oidc.Configuration>;
  private logoutKeys?: JWTVerifyGetKey;
  private readonly logger = new Logger(OidcRelyingParty.name);

  constructor(
    private readonly issuer: URL,
    private readonly client: ClientCredentials,
  ) {}

  /** The authorization code request, with PKCE S256, for one host's callback. */
  async authorizationUrl(request: AuthorizationRequest): Promise<URL> {
    const parameters: Record<string, string> = {
      redirect_uri: request.redirectUri.href,
      scope: 'openid',
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      ui_locales: request.locale,
    };
    if (request.loginHint !== undefined) {
      parameters.login_hint = request.loginHint;
    }
    if (request.acrValues !== undefined) {
      parameters.acr_values = request.acrValues;
    }
    if (request.maxAge !== undefined) {
      parameters.max_age = String(request.maxAge);
    }
    return oidc.buildAuthorizationUrl(await this.discovered(), parameters);
  }

  /**
   * The callback's code, exchanged at the token endpoint, and the ID token
   * checked: state and issuer of the response; signature, `iss`, `aud`,
   * `azp`, `exp`, `iat` and `nonce` of the token.
   */
  async exchange(answer: CallbackAnswer): Promise<VerifiedSignIn> {
    const configuration = await this.discovered();
    const tokens = await this.guarded('sign-in', () =>
      oidc.authorizationCodeGrant(configuration, answer.callbackUrl, {
        pkceCodeVerifier: answer.codeVerifier,
        expectedState: answer.expectedState,
        expectedNonce: answer.expectedNonce,
        idTokenExpected: true,
        // With max_age, `auth_time` is required and must be that recent.
        ...(answer.maxAge !== undefined ? { maxAge: answer.maxAge } : {}),
      }),
    );
    const claims = tokens.claims();
    if (claims === undefined) throw new ProviderAnswerRefusedError('id_token');
    if (claims.iat > Date.now() / 1000 + CLOCK_TOLERANCE_SECONDS) {
      throw new ProviderAnswerRefusedError('id_token:iat');
    }
    return {
      issuer: claims.iss,
      subject: claims.sub,
      sid: isString(claims.sid) ? claims.sid : undefined,
      acr: isString(claims.acr) ? claims.acr : undefined,
      amr: Array.isArray(claims.amr) ? claims.amr.filter(isString) : [],
      authTime:
        typeof claims.auth_time === 'number'
          ? new Date(claims.auth_time * 1000)
          : undefined,
      email: isString(claims.email) ? claims.email : undefined,
      emailVerified: claims.email_verified === true,
    };
  }

  /**
   * A back-channel logout token (OpenID Connect Back-Channel Logout 1.0): signed
   * by the issuer's keys, from the issuer, for this client, with `iat`, `jti`
   * and the logout event, naming a subject or a session, and no `nonce`.
   * Refusing a replayed `jti` is the receiver's (0.5.7).
   */
  async verifyLogoutToken(jwt: string): Promise<LogoutClaims> {
    const metadata = (await this.discovered()).serverMetadata();
    if (metadata.jwks_uri === undefined) {
      throw new DependencyUnavailableError('the issuer publishes no keys');
    }
    this.logoutKeys ??= createRemoteJWKSet(new URL(metadata.jwks_uri), {
      timeoutDuration: TIMEOUT_SECONDS * 1000,
    });
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(jwt, this.logoutKeys, {
        issuer: metadata.issuer,
        audience: this.client.clientId,
        algorithms: LOGOUT_ALGORITHMS,
        requiredClaims: ['iat', 'jti', 'events'],
        // Neither older than the bound nor issued in the future.
        maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SECONDS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch (error) {
      throw this.failureOf('logout', error);
    }
    const events = payload.events;
    if (!isObject(events) || !isObject(events[BACKCHANNEL_LOGOUT_EVENT])) {
      throw new ProviderAnswerRefusedError('logout_token:events');
    }
    if ('nonce' in payload) {
      throw new ProviderAnswerRefusedError('logout_token:nonce');
    }
    const subject = isString(payload.sub) ? payload.sub : undefined;
    const sid = isString(payload.sid) ? payload.sid : undefined;
    if (subject === undefined && sid === undefined) {
      throw new ProviderAnswerRefusedError('logout_token:sub_or_sid');
    }
    if (!isString(payload.jti) || payload.jti === '') {
      throw new ProviderAnswerRefusedError('logout_token:jti');
    }
    return {
      issuer: metadata.issuer,
      jti: payload.jti,
      issuedAt: new Date(Number(payload.iat) * 1000), // a number: jose checked it
      subject,
      sid,
    };
  }

  /**
   * The provider's end-session endpoint, for this client (openid-client adds
   * `client_id`), returning to `postLogoutRedirectUri`.
   */
  async endSessionUrl(request: EndSessionRequest): Promise<URL> {
    return oidc.buildEndSessionUrl(await this.discovered(), {
      post_logout_redirect_uri: request.postLogoutRedirectUri.href,
      ui_locales: request.locale,
    });
  }

  /** An access token for this client itself (the client credentials grant). */
  async clientToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const configuration = await this.discovered();
    const tokens = await this.guarded('client token', () =>
      oidc.clientCredentialsGrant(configuration),
    );
    return {
      accessToken: tokens.access_token,
      expiresIn: tokens.expiresIn() ?? 60,
    };
  }

  /** The issuer's metadata, discovered once; a failed discovery is tried again next time. */
  private discovered(): Promise<oidc.Configuration> {
    this.configuration ??= oidc
      .discovery(
        this.issuer,
        this.client.clientId,
        {
          client_secret: this.client.clientSecret,
          id_token_signed_response_alg: ID_TOKEN_ALGORITHM,
        },
        undefined,
        {
          timeout: TIMEOUT_SECONDS,
          execute: [
            oidc.enableNonRepudiationChecks,
            // HTTP is allowed for an issuer on this machine only (env.schema.ts).
            ...(this.issuer.protocol === 'http:'
              ? [oidc.allowInsecureRequests]
              : []),
          ],
        },
      )
      .catch((error: unknown) => {
        this.configuration = undefined;
        this.logger.warn(`discovery failed: ${codeOf(error)}`);
        throw new DependencyUnavailableError(
          'the identity provider cannot be discovered',
        );
      });
    return this.configuration;
  }

  private async guarded<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.failureOf(what, error);
    }
  }

  /**
   * A failed call, as the caller acts on it: the provider not answering, or
   * its answer refused. Either is named by its check, never by a token or a
   * claim's value.
   */
  private failureOf(what: string, error: unknown): Error {
    const code = codeOf(error);
    const unavailable =
      error instanceof TypeError || // the network
      code === 'OAUTH_TIMEOUT' ||
      code === 'OAUTH_ABORT' ||
      code === 'OAUTH_RESPONSE_IS_NOT_CONFORM' || // an unexpected HTTP status
      code === 'ERR_JWKS_TIMEOUT' ||
      (error instanceof oidc.ResponseBodyError && error.status >= 500);
    if (unavailable) {
      this.logger.warn(
        `${what}: the identity provider did not answer (${code})`,
      );
      return new DependencyUnavailableError(
        'the identity provider did not answer',
      );
    }
    return new ProviderAnswerRefusedError(code);
  }
}

/**
 * The name of what failed: the library's code, with the claim a comparison
 * failed on, or the OAuth error the provider answered with.
 */
function codeOf(error: unknown): string {
  if (
    error instanceof oidc.ResponseBodyError ||
    error instanceof oidc.AuthorizationResponseError
  ) {
    return `${error.code}:${error.error}`;
  }
  if (error instanceof jose.JWTClaimValidationFailed) {
    return `${error.code}:${error.claim}`;
  }
  if (error instanceof jose.JOSEError || error instanceof oidc.ClientError) {
    // openid-client wraps the failed check: the claim's name is on it, beside
    // the claims themselves, which are never read here.
    const claim = claimOf(error.cause) ?? claimOf(causeOf(error.cause));
    return claim === undefined ? String(error.code) : `${error.code}:${claim}`;
  }
  return error instanceof Error ? error.name : 'unknown';
}

const causeOf = (value: unknown): unknown =>
  value instanceof Error ? value.cause : undefined;
const claimOf = (value: unknown): string | undefined => {
  const claim = isObject(value) ? value.claim : undefined;
  return isString(claim) ? claim : undefined;
};
