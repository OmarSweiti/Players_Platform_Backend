import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { JwtModuleOptions } from '@nestjs/jwt';
import { AuthController } from './presentation/auth.controller';
import { LoginUseCase } from './application/use-cases/login.usecase';
import { RegisterUseCase } from './application/use-cases/register.usecase';
import { RefreshTokenUseCase } from './application/use-cases/refresh-token.usecase';
import { ForgotPasswordUseCase } from './application/use-cases/forgot-password.usecase';
import { ResetPasswordUseCase } from './application/use-cases/reset-password.usecase';
import { ChangePasswordUseCase } from './application/use-cases/change-password.usecase';
import { VerifyEmailUseCase } from './application/use-cases/verify-email.usecase';
import { ResendVerificationUseCase } from './application/use-cases/resend-verification.usecase';
import { GetCurrentUserUseCase } from './application/use-cases/get-current-user.usecase';
import { Enable2FAUseCase } from './application/use-cases/enable-2fa.usecase';
import { Verify2FAUseCase } from './application/use-cases/verify-2fa.usecase';
import { Disable2FAUseCase } from './application/use-cases/disable-2fa.usecase';
import { GetActiveSessionsUseCase } from './application/use-cases/get-active-sessions.usecase';
import { RevokeSessionUseCase } from './application/use-cases/revoke-session.usecase';
import { LogoutAllDevicesUseCase } from './application/use-cases/logout-all-devices.usecase';
import { PasswordService } from './application/services/password.service';
import { UserRepository } from './infrastructure/repositories/user.repository';
import { JwtStrategy } from './infrastructure/strategies/jwt.strategy';
import { LocalStrategy } from './infrastructure/strategies/local.strategy';
import { MailService } from '../../infrastructure/mail/mail.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const secret =
          configService.get<string>('jwt.secret') || 'default-secret';
        const expiresIn = configService.get<string>('jwt.expiresIn') || '15m';

        return {
          secret,
          signOptions: {
            expiresIn,
          },
        } as JwtModuleOptions;
      },
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000, // 1 minute
          limit: 5, // 5 attempts per minute for login
        },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [
    LoginUseCase,
    RegisterUseCase,
    RefreshTokenUseCase,
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
    ChangePasswordUseCase,
    VerifyEmailUseCase,
    ResendVerificationUseCase,
    GetCurrentUserUseCase,
    Enable2FAUseCase,
    Verify2FAUseCase,
    Disable2FAUseCase,
    GetActiveSessionsUseCase,
    RevokeSessionUseCase,
    LogoutAllDevicesUseCase,
    PasswordService,
    UserRepository,
    JwtStrategy,
    LocalStrategy,
    MailService,
  ],
  exports: [PasswordService, UserRepository],
})
export class AuthModule {}
