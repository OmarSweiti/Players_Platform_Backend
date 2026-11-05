import { Logger } from '@nestjs/common';
import { DependencyUnavailableError } from '../../../../common/errors/domain-error';
import { OidcRelyingParty } from './oidc-relying-party';

/** How long one admin call may take. */
const TIMEOUT_MS = 10_000;
/** An admin token is renewed this long before it expires. */
const TOKEN_MARGIN_SECONDS = 30;

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

/**
 * The realm's admin REST API, as one service account (0.5.4; 0.5.9): the API's
 * `sadara-admin`, which manages users, or the provisioning command's
 * `sadara-provisioner`, which manages clients — each held apart, each with
 * only what its holder needs. Every call times out, follows no redirect, and
 * renews an expired token once; a provider that does not answer is a
 * dependency unavailable. Nothing is called at construction.
 */
export class KeycloakAdminApi {
  private readonly account: OidcRelyingParty;
  private readonly base: string;
  private token?: { value: string; until: number };
  private readonly logger = new Logger(KeycloakAdminApi.name);

  constructor(
    issuer: URL,
    credentials: { clientId: string; clientSecret: string },
  ) {
    this.account = new OidcRelyingParty(issuer, credentials);
    this.base = adminApiOf(issuer);
  }

  /** One call, `path` under the realm's admin API. */
  async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    renewed = false,
  ): Promise<Response> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
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
      this.token = undefined;
      return this.call(method, path, body, true);
    }
    return response;
  }

  /** An answer the caller does not expect: logged by status, never by content. */
  unexpected(what: string, status: number): DependencyUnavailableError {
    this.logger.warn(`${what}: the identity provider answered ${status}`);
    return new DependencyUnavailableError(
      `the identity provider refused to ${what}`,
    );
  }

  private async accessToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.token === undefined || this.token.until <= now) {
      const { accessToken, expiresIn } = await this.account.clientToken();
      this.token = {
        value: accessToken,
        until: now + expiresIn - TOKEN_MARGIN_SECONDS,
      };
    }
    return this.token.value;
  }
}
