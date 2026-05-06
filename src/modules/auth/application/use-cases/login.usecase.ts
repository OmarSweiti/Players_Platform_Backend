import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { PasswordService } from '../services/password.service';
import { LoginDto } from '../../presentation/dto/login.dto';

@Injectable()
export class LoginUseCase {
  constructor(
    private userRepository: UserRepository,
    private passwordService: PasswordService,
    private jwtService: JwtService,
  ) {}

  /**
   * Validate user credentials without generating tokens
   */
  async validateUser(email: string, password: string, tenantId: string): Promise<any> {
    const user = await this.userRepository.findByEmail(email, tenantId);
    
    if (!user) {
      return null;
    }

    // Check if account is locked
    if (user.lockedUntil && new Date() < user.lockedUntil) {
      throw new UnauthorizedException('Account is temporarily locked due to too many failed attempts');
    }

    const isValid = await this.passwordService.verify(user.passwordHash, password);
    
    if (!isValid) {
      await this.handleFailedLogin(user.id);
      return null;
    }

    return user;
  }

  /**
   * Execute login and generate tokens
   */
  async execute(dto: LoginDto, tenantId: string) {
    const user = await this.validateUser(dto.email, dto.password, tenantId);
    
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = this.generateTokens(user);
    
    await this.userRepository.updateLastLogin(user.id);

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
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: '7d',
      }),
    };
  }

  private async handleFailedLogin(userId: string) {
    const user = await this.userRepository.incrementFailedLoginAttempts(userId);
    
    // Lock account after 5 failed attempts
    if (user.failedLoginAttempts >= 5) {
      const lockedUntil = new Date();
      lockedUntil.setMinutes(lockedUntil.getMinutes() + 30); // Lock for 30 minutes
      await this.userRepository.lockAccount(userId, lockedUntil);
    }
  }
}
