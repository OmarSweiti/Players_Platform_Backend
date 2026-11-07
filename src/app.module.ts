import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { configOptions } from './config/env.schema';
import { BodyParsingModule } from './common/http/body-parsing.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { EventsModule } from './infrastructure/events/events.module';
import { MailModule } from './infrastructure/mail/mail.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { UsersModule } from './modules/users/users.module';
import { PlayersModule } from './modules/players/players.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { TrainingModule } from './modules/training/training.module';
import { LegalModule } from './modules/legal/legal.module';
import { ChatModule } from './modules/chat/chat.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ScoutingModule } from './modules/scouting/scouting.module';
import { MedicalModule } from './modules/medical/medical.module';
import { IdentityModule } from './modules/identity/identity.module';
import { HealthModule } from './health/health.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard';
import { FeatureGateGuard } from './common/feature-flags/feature-gate.guard';
import { SessionGuard } from './common/guards/session.guard';
import { CsrfGuard } from './common/security/csrf.guard';
import { PermissionGuard } from './common/guards/permission.guard';
import { RecentAuthGuard } from './common/guards/recent-auth.guard';
import { PermissionCatalogCheck } from './common/authz/permission-catalog-check';

@Module({
  imports: [
    // Validates the environment as this module loads: the API refuses to
    // boot on a missing or invalid variable (src/config/env.schema.ts).
    ConfigModule.forRoot(configOptions),
    // Structured logs: the access log, and every other line as JSON.
    LoggingModule,
    // Request bodies, read once the access log has started.
    BodyParsingModule,
    PrismaModule,
    EventsModule,
    MailModule,
    StorageModule,
    IdentityModule,
    UsersModule,
    PlayersModule,
    ContractsModule,
    TrainingModule,
    LegalModule,
    ChatModule,
    NotificationsModule,
    ScoutingModule,
    MedicalModule,
    HealthModule,
    RateLimitModule,
  ],
  providers: [
    // The API refuses to start when the database's permission catalog or
    // default matrix is not the code's (0.6.1).
    PermissionCatalogCheck,
    // Global guards run in this order. The feature gate is first: a disabled
    // module's routes answer 404 before authentication can answer 401.
    { provide: APP_GUARD, useClass: FeatureGateGuard },
    // Every route not @Public() needs a session, checked in PostgreSQL on
    // every request; the guard mints the request's tenant context (0.5.6).
    { provide: APP_GUARD, useClass: SessionGuard },
    // After the session, so that a signed-in member counts as themselves;
    // before permissions, so that a refused request counts too.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // After the session, whose token a write must carry (0.5.6); before
    // permissions, so that a forged write learns nothing of them.
    { provide: APP_GUARD, useClass: CsrfGuard },
    // Deny by default: a route's permission, a signed-in member on their own
    // session, or anyone — exactly one, declared (0.6.2).
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Last: a sensitive action asks for a recent authentication (0.5.8) only
    // of a member who may take it.
    { provide: APP_GUARD, useClass: RecentAuthGuard },
  ],
})
export class AppModule {}
