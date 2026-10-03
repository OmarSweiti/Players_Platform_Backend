import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env.schema';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { PasswordService } from '../services/password.service';
import { LoginDto } from '../../presentation/dto/login.dto';
import {
  describeError,
  stackFramesOf,
} from '../../../../common/logging/describe-error';

@Injectable()
export class LoginUseCase {
  private readonly logger = new Logger(LoginUseCase.name);

  constructor(
    private userRepository: UserRepository,
    private passwordService: PasswordService,
    private jwtService: JwtService,
    private config: ConfigService<Env, true>,
  ) {}

  /**
   * Validate user credentials without generating tokens
   */
  async validateUser(
    email: string,
    password: string,
    tenantId: string,
  ): Promise<any> {
    const user = await this.userRepository.findByEmail(email, tenantId);

    if (!user) {
      // SECURITY: Log failed login attempt (don't reveal if email exists)
      this.logger.warn('Failed login attempt: no account has that address');
      return null;
    }

    // Check if account is locked
    if (user.lockedUntil && new Date() < user.lockedUntil) {
      this.logger.warn(
        `Login blocked - Account locked: user ${user.id} (locked until: ${user.lockedUntil.toISOString()})`,
      );
      throw new UnauthorizedException(
        'Account is temporarily locked due to too many failed attempts',
      );
    }

    const isValid = await this.passwordService.verify(
      user.passwordHash,
      password,
    );

    if (!isValid) {
      this.logger.warn(`Invalid password for user ${user.id}`);
      await this.handleFailedLogin(user.id);
      return null;
    }

    return user;
  }

  /**
   * Execute login and generate tokens
   */
  async execute(dto: LoginDto, tenantId: string) {
    const startTime = Date.now();

    try {
      const user = await this.validateUser(dto.email, dto.password, tenantId);

      if (!user) {
        const duration = Date.now() - startTime;
        this.logger.warn(`Login failed after ${duration}ms`);
        throw new UnauthorizedException('Invalid credentials');
      }

      const tokens = this.generateTokens(user);

      await this.userRepository.updateLastLogin(user.id);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Successful login: user ${user.id} (tenant: ${tenantId}, role: ${user.role}, duration: ${duration}ms)`,
      );

      return {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          tenantId: user.tenantId,
        },
        ...tokens,
      };
    } catch (error) {
      this.logger.error(
        `Login error: ${describeError(error)}`,
        stackFramesOf(error),
      );
      throw error;
    }
  }

  private generateTokens(user: any) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken: this.jwtService.sign(payload, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: '7d',
      }),
    };
  }

  private async handleFailedLogin(userId: string) {
    const user = await this.userRepository.incrementFailedLoginAttempts(userId);

    this.logger.warn(
      `Failed login attempt #${user.failedLoginAttempts} for user ID: ${userId}`,
    );

    // Lock account after 5 failed attempts
    if (user.failedLoginAttempts >= 5) {
      const lockedUntil = new Date();
      lockedUntil.setMinutes(lockedUntil.getMinutes() + 30); // Lock for 30 minutes
      await this.userRepository.lockAccount(userId, lockedUntil);

      this.logger.warn(
        `Account LOCKED: User ID ${userId} locked until ${lockedUntil.toISOString()}`,
      );
    }
  }
}
