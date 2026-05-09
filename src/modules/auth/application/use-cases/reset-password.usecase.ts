import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { PasswordService } from '../services/password.service';
import { ResetPasswordDto } from '../../presentation/dto/reset-password.dto';

@Injectable()
export class ResetPasswordUseCase {
  constructor(
    private userRepository: UserRepository,
    private passwordService: PasswordService,
  ) {}

  async execute(dto: ResetPasswordDto, tenantId: string) {
    // Hash the token to compare with stored hash
    const hashedToken = crypto.createHash('sha256').update(dto.token).digest('hex');

    // Find user with valid reset token
    const user = await this.userRepository.findByResetToken(hashedToken, tenantId);

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Check if token has expired
    if (!user.passwordResetExpiry || new Date() > user.passwordResetExpiry) {
      throw new BadRequestException('Reset token has expired');
    }

    // Validate password strength
    this.validatePasswordStrength(dto.newPassword);

    // Hash new password
    const passwordHash = await this.passwordService.hash(dto.newPassword);

    // Update password and clear reset token
    await this.userRepository.update(user.id, {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpiry: null,
      passwordChangedAt: new Date(),
    });

    // Invalidate all existing sessions by updating passwordChangedAt
    // This will cause JWT validation to fail for old tokens

    return { message: 'Password has been reset successfully' };
  }

  private validatePasswordStrength(password: string): void {
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

    if (password.length < minLength) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }
    if (!hasUpperCase) {
      throw new BadRequestException('Password must contain at least one uppercase letter');
    }
    if (!hasLowerCase) {
      throw new BadRequestException('Password must contain at least one lowercase letter');
    }
    if (!hasNumbers) {
      throw new BadRequestException('Password must contain at least one number');
    }
    if (!hasSpecialChar) {
      throw new BadRequestException('Password must contain at least one special character');
    }
  }
}
