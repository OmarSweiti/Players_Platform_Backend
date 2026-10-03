import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { configOptions } from './config/env.schema';
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
import { HealthController } from './health/health.controller';
import { FeatureGateGuard } from './common/feature-flags/feature-gate.guard';
import { SessionGuard } from './common/guards/session.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { ValidationPipe } from './common/pipes/validation.pipe';

@Module({
  imports: [
    // Validates the environment as this module loads: the API refuses to
    // boot on a missing or invalid variable (src/config/env.schema.ts).
    ConfigModule.forRoot(configOptions),
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
  ],
  controllers: [HealthController],
  providers: [
    // Global guards run in this order. The feature gate is first: a disabled
    // module's routes answer 404 before authentication can answer 401.
    { provide: APP_GUARD, useClass: FeatureGateGuard },
    // useExisting, so a test can stand in for sessions (overrideProvider)
    SessionGuard,
    { provide: APP_GUARD, useExisting: SessionGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_PIPE, useClass: ValidationPipe },
  ],
})
export class AppModule {}
