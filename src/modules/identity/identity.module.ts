import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { CsrfTokens } from '../../common/security/csrf-tokens';
import { CLOCK, systemClock } from '../../common/time/clock';
import { IdentityProviderPort } from './application/ports/identity-provider.port';
import { SessionViews } from './application/ports/session-views.port';
import { SignInAttempts } from './application/ports/sign-in-attempts.port';
import { SessionService } from './application/session.service';
import { ReadSessionUseCase } from './application/use-cases/read-session.usecase';
import { SignInUseCase } from './application/use-cases/sign-in.usecase';
import { KeycloakIdentityProvider } from './infrastructure/keycloak/keycloak-identity-provider';
import { SessionViewRepository } from './infrastructure/repositories/session-view.repository';
import { ValkeySignInAttempts } from './infrastructure/valkey/valkey-sign-in-attempts';
import { AuthController } from './presentation/auth.controller';

// Identity: the identity provider behind its port (0.5.4), sign-in through
// the API (0.5.5), and the sessions it opens (0.5.6), which the global session
// and CSRF guards (app.module.ts) check. Invitations (0.5.10) join it.
@Module({
  // The limiter counts the account being signed in to (0.3.8).
  imports: [RateLimitModule],
  controllers: [AuthController],
  providers: [
    { provide: IdentityProviderPort, useClass: KeycloakIdentityProvider },
    { provide: SignInAttempts, useClass: ValkeySignInAttempts },
    { provide: SessionViews, useClass: SessionViewRepository },
    { provide: CLOCK, useValue: systemClock },
    CsrfTokens,
    SessionService,
    SignInUseCase,
    ReadSessionUseCase,
  ],
  exports: [IdentityProviderPort, SessionService, CsrfTokens],
})
export class IdentityModule {}
