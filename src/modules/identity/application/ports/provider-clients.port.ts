/**
 * The identity provider's sign-in client, as tenant provisioning changes it
 * (0.5.9): every tenant host is registered by its exact callback and
 * post-logout addresses (0.5.1), never by a wildcard.
 */
export abstract class ProviderClients {
  /**
   * Registers `host` on the sign-in client: `https://{host}/api/v1/auth/
   * callback` among its redirect URIs, and `https://{host}/` among its
   * post-logout ones. Idempotent: `added` says whether anything changed.
   */
  abstract registerHost(host: string): Promise<{ added: boolean }>;
}
