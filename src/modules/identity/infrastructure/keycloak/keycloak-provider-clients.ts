import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import { API_VERSION } from '../../../../app.setup';
import { HOST_NAME, type ProvisioningEnv } from '../../../../config/env.schema';
import { ProviderClients } from '../../application/ports/provider-clients.port';
import { KeycloakAdminApi } from './keycloak-admin-api';

/** How Keycloak keeps a client's post-logout redirect URIs: one attribute. */
const POST_LOGOUT = 'post.logout.redirect.uris';
const SEPARATOR = '##';

interface ClientRepresentation {
  id: string;
  redirectUris?: string[];
  attributes?: Record<string, string>;
  [field: string]: unknown;
}

/**
 * The sign-in client at Keycloak, changed as the provisioning service account
 * `OIDC_PROVISIONER_CLIENT_ID` (0.5.9), which the realm lets manage clients
 * and nothing else (the umbrella's infra/keycloak/realm-sadara.json). Only
 * the provisioning command wires this; the API never holds that account.
 */
@Injectable()
export class KeycloakProviderClients extends ProviderClients {
  private readonly adminApi: KeycloakAdminApi;
  private readonly signInClientId: string;
  private readonly callbackPath: string;

  constructor(config: ConfigService<ProvisioningEnv, true>) {
    super();
    this.adminApi = new KeycloakAdminApi(
      new URL(config.get('OIDC_ISSUER', { infer: true })),
      {
        clientId: config.get('OIDC_PROVISIONER_CLIENT_ID', { infer: true }),
        clientSecret: config.get('OIDC_PROVISIONER_CLIENT_SECRET', {
          infer: true,
        }),
      },
    );
    this.signInClientId = config.get('OIDC_CLIENT_ID', { infer: true });
    this.callbackPath = `/${config.get('API_PREFIX', { infer: true })}/v${API_VERSION}/auth/callback`;
  }

  async registerHost(host: string): Promise<{ added: boolean }> {
    if (!HOST_NAME.test(host)) {
      throw new ValidationFailedError('not a lower-case host name', [
        { field: '/host', code: 'INVALID_FORMAT' },
      ]);
    }
    const callback = `https://${host}${this.callbackPath}`;
    const start = `https://${host}/`;
    const client = await this.signInClient();
    const redirects = client.redirectUris ?? [];
    const attributes = client.attributes ?? {};
    const postLogout = (attributes[POST_LOGOUT] ?? '')
      .split(SEPARATOR)
      .filter((uri) => uri !== '');
    if (redirects.includes(callback) && postLogout.includes(start)) {
      return { added: false };
    }
    // Keycloak replaces a client with the representation it is sent: the one
    // just read, with the host's two addresses added and nothing else changed.
    const updated: ClientRepresentation = {
      ...client,
      redirectUris: redirects.includes(callback)
        ? redirects
        : [...redirects, callback],
      attributes: {
        ...attributes,
        [POST_LOGOUT]: (postLogout.includes(start)
          ? postLogout
          : [...postLogout, start]
        ).join(SEPARATOR),
      },
    };
    const response = await this.adminApi.call(
      'PUT',
      `/clients/${client.id}`,
      updated,
    );
    await response.body?.cancel();
    if (response.status !== 204) {
      throw this.adminApi.unexpected('register a host', response.status);
    }
    return { added: true };
  }

  /** The sign-in client's full representation. */
  private async signInClient(): Promise<ClientRepresentation> {
    const response = await this.adminApi.call(
      'GET',
      `/clients?clientId=${encodeURIComponent(this.signInClientId)}`,
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw this.adminApi.unexpected(
        'read the sign-in client',
        response.status,
      );
    }
    const [client] = (await response.json()) as ClientRepresentation[];
    if (client === undefined || typeof client.id !== 'string') {
      throw this.adminApi.unexpected('find the sign-in client', 404);
    }
    return client;
  }
}
