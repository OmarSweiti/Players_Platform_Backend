import { Module } from '@nestjs/common';
import { IdentityProviderPort } from './application/ports/identity-provider.port';
import { ProviderClients } from './application/ports/provider-clients.port';
import { KeycloakIdentityProvider } from './infrastructure/keycloak/keycloak-identity-provider';
import { KeycloakProviderClients } from './infrastructure/keycloak/keycloak-provider-clients';

// The identity provider's administration, for platform operations (0.5.9):
// its accounts, as the API's service account, and its sign-in client, as the
// provisioning service account. No routes, no sessions, no Valkey: the
// provisioning command's composition, never the API's (IdentityModule).
@Module({
  providers: [
    { provide: IdentityProviderPort, useClass: KeycloakIdentityProvider },
    { provide: ProviderClients, useClass: KeycloakProviderClients },
  ],
  exports: [IdentityProviderPort, ProviderClients],
})
export class IdentityAdminModule {}
