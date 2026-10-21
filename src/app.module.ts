import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { configOptions } from './config/env.schema';
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
import { HealthModule } from './health/health.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard';
import { FeatureGateGuard } from './common/feature-flags/feature-gate.guard';
import { SessionGuard } from './common/guards/session.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    // Validates the environment as this module loads: the API refuses to
    // boot on a missing or invalid variable (src/config/env.schema.ts).
    ConfigModule.forRoot(configOptions),
    // Structured logs: the access log, and every other line as JSON.
    LoggingModule,
    PrismaModule,
    EventsModule,
    MailModule,
    StorageModule,
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
    // Global guards run in this order. The feature gate is first: a disabled
    // module's routes answer 404 before authentication can answer 401.
    { provide: APP_GUARD, useClass: FeatureGateGuard },
    // useExisting, so a test can stand in for sessions (overrideProvider)
    SessionGuard,
    { provide: APP_GUARD, useExisting: SessionGuard },
    // After the session, so that a signed-in member counts as themselves;
    // before permissions, so that a refused request counts too.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
