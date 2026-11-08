import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { CsrfTokens } from '../../common/security/csrf-tokens';
import { CLOCK, systemClock } from '../../common/time/clock';
import { PermissionsModule } from '../users/permissions.module';
import { AssurancePolicy } from './application/assurance.policy';
import { IdentityProviderPort } from './application/ports/identity-provider.port';
import { LogoutTokenReplays } from './application/ports/logout-token-replays.port';
import { OwnSessions } from './application/ports/own-sessions.port';
import { SessionViews } from './application/ports/session-views.port';
import { SignInAttempts } from './application/ports/sign-in-attempts.port';
import { SessionService } from './application/session.service';
import { BackchannelLogoutUseCase } from './application/use-cases/backchannel-logout.usecase';
import { OwnSessionsUseCase } from './application/use-cases/own-sessions.usecase';
import { ReadSessionUseCase } from './application/use-cases/read-session.usecase';
import { SignInUseCase } from './application/use-cases/sign-in.usecase';
import { SignOutUseCase } from './application/use-cases/sign-out.usecase';
import { KeycloakIdentityProvider } from './infrastructure/keycloak/keycloak-identity-provider';
import { OwnSessionRepository } from './infrastructure/repositories/own-session.repository';
import { SessionViewRepository } from './infrastructure/repositories/session-view.repository';
import { IdentityValkey } from './infrastructure/valkey/identity-valkey';
import { ValkeyLogoutTokenReplays } from './infrastructure/valkey/valkey-logout-token-replays';
import { ValkeySignInAttempts } from './infrastructure/valkey/valkey-sign-in-attempts';
import { AuthController } from './presentation/auth.controller';

// Identity: the identity provider behind its port (0.5.4), sign-in through
// the API (0.5.5), the sessions it opens (0.5.6), which the global session and
// CSRF guards (app.module.ts) check, signing out (0.5.7), and assurance:
// second factors for privileged roles and step-up for sensitive actions
// (0.5.8). Invitations (0.5.10) join it. The session lists the member's
// effective permissions (0.6.6).
@Module({
  // The limiter counts the account being signed in to (0.3.8); the session
  // lists the member's effective permissions (0.6.6).
  imports: [RateLimitModule, PermissionsModule],
  controllers: [AuthController],
  providers: [
    { provide: IdentityProviderPort, useClass: KeycloakIdentityProvider },
    { provide: SignInAttempts, useClass: ValkeySignInAttempts },
    { provide: SessionViews, useClass: SessionViewRepository },
    { provide: OwnSessions, useClass: OwnSessionRepository },
    { provide: LogoutTokenReplays, useClass: ValkeyLogoutTokenReplays },
    IdentityValkey,
    { provide: CLOCK, useValue: systemClock },
    CsrfTokens,
    AssurancePolicy,
    SessionService,
    SignInUseCase,
    ReadSessionUseCase,
    SignOutUseCase,
    OwnSessionsUseCase,
    BackchannelLogoutUseCase,
  ],
  exports: [IdentityProviderPort, SessionService, CsrfTokens, AssurancePolicy],
})
export class IdentityModule {}
