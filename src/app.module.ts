import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER, APP_PIPE } from '@nestjs/core';
import { configOptions } from './config/env.schema';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { EventsModule } from './infrastructure/events/events.module';
import { MailModule } from './infrastructure/mail/mail.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
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
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
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
    AuthModule,
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
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_PIPE, useClass: ValidationPipe },
  ],
})
export class AppModule {}
