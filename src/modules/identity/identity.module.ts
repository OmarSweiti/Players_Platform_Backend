import { Module } from '@nestjs/common';
import { IdentityProviderPort } from './application/ports/identity-provider.port';
import { KeycloakIdentityProvider } from './infrastructure/keycloak/keycloak-identity-provider';

// Identity (0.5.4): the identity provider behind its port. Sign-in (0.5.5),
// sessions (0.5.6) and invitations (0.5.10) join this module.
@Module({
  providers: [
    { provide: IdentityProviderPort, useClass: KeycloakIdentityProvider },
  ],
  exports: [IdentityProviderPort],
})
export class IdentityModule {}
