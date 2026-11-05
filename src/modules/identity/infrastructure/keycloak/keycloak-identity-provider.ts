import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env.schema';
import {
  AccountExistsError,
  AccountNotFoundError,
  IdentityProviderPort,
  type AuthorizationRequest,
  type CallbackAnswer,
  type EndSessionRequest,
  type Locale,
  type LogoutClaims,
  type RequiredAction,
  type VerifiedSignIn,
} from '../../application/ports/identity-provider.port';
import { KeycloakAdminApi } from './keycloak-admin-api';
import { OidcRelyingParty } from './oidc-relying-party';

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
  private readonly adminApi: KeycloakAdminApi;

  constructor(config: ConfigService<Env, true>) {
    super();
    const issuer = new URL(config.get('OIDC_ISSUER', { infer: true }));
    this.signIn = new OidcRelyingParty(issuer, {
      clientId: config.get('OIDC_CLIENT_ID', { infer: true }),
      clientSecret: config.get('OIDC_CLIENT_SECRET', { infer: true }),
    });
    this.adminApi = new KeycloakAdminApi(issuer, {
      clientId: config.get('OIDC_ADMIN_CLIENT_ID', { infer: true }),
      clientSecret: config.get('OIDC_ADMIN_CLIENT_SECRET', { infer: true }),
    });
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

  endSessionUrl(request: EndSessionRequest): Promise<URL> {
    return this.signIn.endSessionUrl(request);
  }

  async createAccount(
    email: string,
    locale: Locale,
    requiredActions: readonly RequiredAction[],
  ): Promise<{ subject: string }> {
    const response = await this.adminApi.call('POST', '/users', {
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
      throw this.adminApi.unexpected('create account', response.status);
    }
    return { subject };
  }

  async sendSetupEmail(subject: string): Promise<void> {
    const user = await this.account(subject);
    const actions = Array.isArray(user.requiredActions)
      ? user.requiredActions.filter((a): a is string => typeof a === 'string')
      : [];
    if (actions.length === 0) return; // nothing is pending: nothing to send
    const response = await this.adminApi.call(
      'PUT',
      `/users/${subject}/execute-actions-email`,
      actions,
    );
    await response.body?.cancel();
    if (response.status === 404) throw new AccountNotFoundError();
    if (response.status !== 204) {
      throw this.adminApi.unexpected('send setup email', response.status);
    }
  }

  async disableAccount(subject: string): Promise<void> {
    if (!SUBJECT.test(subject)) throw new AccountNotFoundError();
    const disabled = await this.adminApi.call('PUT', `/users/${subject}`, {
      enabled: false,
    });
    await disabled.body?.cancel();
    if (disabled.status === 404) throw new AccountNotFoundError();
    if (disabled.status !== 204) {
      throw this.adminApi.unexpected('disable account', disabled.status);
    }
    // Its sessions at the provider end too.
    const loggedOut = await this.adminApi.call(
      'POST',
      `/users/${subject}/logout`,
    );
    await loggedOut.body?.cancel();
    if (loggedOut.status !== 204) {
      throw this.adminApi.unexpected('end account sessions', loggedOut.status);
    }
  }

  /** The user `subject` names, as the admin API represents it. */
  private async account(subject: string): Promise<Record<string, unknown>> {
    if (!SUBJECT.test(subject)) throw new AccountNotFoundError();
    const response = await this.adminApi.call('GET', `/users/${subject}`);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new AccountNotFoundError();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw this.adminApi.unexpected('read account', response.status);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

export { adminApiOf } from './keycloak-admin-api';
