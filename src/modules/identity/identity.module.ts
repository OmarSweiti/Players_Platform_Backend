import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { CLOCK, systemClock } from '../../common/time/clock';
import { IdentityProviderPort } from './application/ports/identity-provider.port';
import { SignInAttempts } from './application/ports/sign-in-attempts.port';
import { SignInUseCase } from './application/use-cases/sign-in.usecase';
import { KeycloakIdentityProvider } from './infrastructure/keycloak/keycloak-identity-provider';
import { ValkeySignInAttempts } from './infrastructure/valkey/valkey-sign-in-attempts';
import { AuthController } from './presentation/auth.controller';

// Identity: the identity provider behind its port (0.5.4), and sign-in
// through the API (0.5.5). Sessions (0.5.6) and invitations (0.5.10) join it.
@Module({
  // The limiter counts the account being signed in to (0.3.8).
  imports: [RateLimitModule],
  controllers: [AuthController],
  providers: [
    { provide: IdentityProviderPort, useClass: KeycloakIdentityProvider },
    { provide: SignInAttempts, useClass: ValkeySignInAttempts },
    { provide: CLOCK, useValue: systemClock },
    SignInUseCase,
  ],
  exports: [IdentityProviderPort],
})
export class IdentityModule {}
