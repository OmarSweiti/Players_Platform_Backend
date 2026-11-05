import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DependencyUnavailableError } from '../../../../common/errors/domain-error';
import type { Env } from '../../../../config/env.schema';
import {
  AccountExistsError,
  AccountNotFoundError,
  IdentityProviderPort,
  type AuthorizationRequest,
  type CallbackAnswer,
  type Locale,
  type LogoutClaims,
  type RequiredAction,
  type VerifiedSignIn,
} from '../../application/ports/identity-provider.port';
import { OidcRelyingParty } from './oidc-relying-party';

/** How long one admin call may take. */
const TIMEOUT_MS = 10_000;
/** An admin token is renewed this long before it expires. */
const TOKEN_MARGIN_SECONDS = 30;

/** Keycloak's names for the port's required actions. */
const KEYCLOAK_ACTION: Record<RequiredAction, string> = {
  VERIFY_EMAIL: 'VERIFY_EMAIL',
  SET_PASSWORD: 'UPDATE_PASSWORD',
  CONFIGURE_OTP: 'CONFIGURE_TOTP',
};

/** A Keycloak user id, which is the subject of its ID tokens. */
const SUBJECT = /^[A-Za-z0-9-]{1,255}$/;

/**
 * The identity provider as Keycloak (0.5.4; ADR-0002). Sign-in, logout tokens
 * and the admin token go through OpenID Connect (`OidcRelyingParty`), as the
 * API's client and as its service account. Accounts are managed through the
 * realm's admin REST API, as the service account `OIDC_ADMIN_CLIENT_ID`, which
 * the realm lets manage users and nothing else (the umbrella's
 * infra/keycloak/realm-sadara.json). No call is made at boot.
 */
@Injectable()
export class KeycloakIdentityProvider extends IdentityProviderPort {
  private readonly signIn: OidcRelyingParty;
  private readonly serviceAccount: OidcRelyingParty;
  private readonly adminApi: string;
  private adminToken?: { value: string; until: number };
  private readonly logger = new Logger(KeycloakIdentityProvider.name);

  constructor(config: ConfigService<Env, true>) {
    super();
    const issuer = new URL(config.get('OIDC_ISSUER', { infer: true }));
    this.signIn = new OidcRelyingParty(issuer, {
      clientId: config.get('OIDC_CLIENT_ID', { infer: true }),
      clientSecret: config.get('OIDC_CLIENT_SECRET', { infer: true }),
    });
    this.serviceAccount = new OidcRelyingParty(issuer, {
      clientId: config.get('OIDC_ADMIN_CLIENT_ID', { infer: true }),
      clientSecret: config.get('OIDC_ADMIN_CLIENT_SECRET', { infer: true }),
    });
    this.adminApi = adminApiOf(issuer);
  }

  authorizationUrl(request: AuthorizationRequest): Promise<URL> {
    return this.signIn.authorizationUrl(request);
  }

  exchange(callback: CallbackAnswer): Promise<VerifiedSignIn> {
    return this.signIn.exchange(callback);
  }

  verifyLogoutToken(jwt: string): Promise<LogoutClaims> {
    return this.signIn.verifyLogoutToken(jwt);
  }

  async createAccount(
    email: string,
    locale: Locale,
    requiredActions: readonly RequiredAction[],
  ): Promise<{ subject: string }> {
    const response = await this.admin('POST', '/users', {
      username: email,
      email,
      enabled: true,
      emailVerified: false,
      attributes: { locale: [locale] },
      requiredActions: requiredActions.map((action) => KEYCLOAK_ACTION[action]),
    });
    await response.body?.cancel();
    if (response.status === 409) throw new AccountExistsError();
    // The new user's id is the last segment of its Location.
    const subject = response.headers.get('location')?.split('/').pop();
    if (
      response.status !== 201 ||
      subject === undefined ||
      !SUBJECT.test(subject)
    ) {
      throw this.unexpected('create account', response.status);
    }
    return { subject };
  }

  async sendSetupEmail(subject: string): Promise<void> {
    const user = await this.account(subject);
    const actions = Array.isArray(user.requiredActions)
      ? user.requiredActions.filter((a): a is string => typeof a === 'string')
      : [];
    if (actions.length === 0) return; // nothing is pending: nothing to send
    const response = await this.admin(
      'PUT',
      `/users/${subject}/execute-actions-email`,
      actions,
    );
    await response.body?.cancel();
    if (response.status === 404) throw new AccountNotFoundError();
    if (response.status !== 204) {
      throw this.unexpected('send setup email', response.status);
    }
  }

  async disableAccount(subject: string): Promise<void> {
    if (!SUBJECT.test(subject)) throw new AccountNotFoundError();
    const disabled = await this.admin('PUT', `/users/${subject}`, {
      enabled: false,
    });
    await disabled.body?.cancel();
    if (disabled.status === 404) throw new AccountNotFoundError();
    if (disabled.status !== 204) {
      throw this.unexpected('disable account', disabled.status);
    }
    // Its sessions at the provider end too.
    const loggedOut = await this.admin('POST', `/users/${subject}/logout`);
    await loggedOut.body?.cancel();
    if (loggedOut.status !== 204) {
      throw this.unexpected('end account sessions', loggedOut.status);
    }
  }

  /** The user `subject` names, as the admin API represents it. */
  private async account(subject: string): Promise<Record<string, unknown>> {
    if (!SUBJECT.test(subject)) throw new AccountNotFoundError();
    const response = await this.admin('GET', `/users/${subject}`);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new AccountNotFoundError();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw this.unexpected('read account', response.status);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * One admin API call as the service account. An expired token is renewed
   * once; a provider that does not answer is a dependency unavailable.
   */
  private async admin(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    renewed = false,
  ): Promise<Response> {
    const token = await this.adminAccessToken();
    let response: Response;
    try {
      response = await fetch(`${this.adminApi}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(
        `admin ${method}: the identity provider did not answer (${(error as Error).name})`,
      );
      throw new DependencyUnavailableError(
        'the identity provider did not answer',
      );
    }
    if (response.status === 401 && !renewed) {
      await response.body?.cancel();
      this.adminToken = undefined;
      return this.admin(method, path, body, true);
    }
    return response;
  }

  private async adminAccessToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.adminToken === undefined || this.adminToken.until <= now) {
      const { accessToken, expiresIn } =
        await this.serviceAccount.clientToken();
      this.adminToken = {
        value: accessToken,
        until: now + expiresIn - TOKEN_MARGIN_SECONDS,
      };
    }
    return this.adminToken.value;
  }

  /** An answer the adapter does not expect: logged by status, never by content. */
  private unexpected(what: string, status: number): DependencyUnavailableError {
    this.logger.warn(`${what}: the identity provider answered ${status}`);
    return new DependencyUnavailableError(
      'the identity provider refused an account change',
    );
  }
}

/**
 * The realm's admin API, from its issuer: Keycloak serves a realm's issuer at
 * `{base}/realms/{realm}` and its admin API at `{base}/admin/realms/{realm}`.
 */
export function adminApiOf(issuer: URL): string {
  const realm = /^(.*)\/realms\/([^/]+)\/?$/.exec(issuer.pathname);
  if (realm === null) {
    // A configuration error, at boot: the API cannot manage accounts.
    throw new Error(
      "OIDC_ISSUER is not a Keycloak realm's issuer (…/realms/<realm>)",
    );
  }
  return `${issuer.origin}${realm[1]}/admin/realms/${realm[2]}`;
}
