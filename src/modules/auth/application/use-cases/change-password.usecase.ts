import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { RequestWithUser } from '../../../../common/interfaces/request-with-user.interface';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { PasswordService } from '../services/password.service';
import { ChangePasswordDto } from '../../presentation/dto/change-password.dto';

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    private userRepository: UserRepository,
    private passwordService: PasswordService,
  ) {}

  async execute(dto: ChangePasswordDto, req: RequestWithUser) {
    const userId = req.user?.id;
    const tenantId = req.tenantId;

    if (!userId || !tenantId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const user = await this.userRepository.findById(userId, tenantId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Verify current password
    const isValid = await this.passwordService.verify(user.passwordHash, dto.currentPassword);

    if (!isValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Validate new password strength
    this.validatePasswordStrength(dto.newPassword);

    // Check if new password is different from current
    const isSamePassword = await this.passwordService.verify(user.passwordHash, dto.newPassword);
    if (isSamePassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    // Hash and update password
    const passwordHash = await this.passwordService.hash(dto.newPassword);
    await this.userRepository.update(userId, {
      passwordHash,
      passwordChangedAt: new Date(),
    });

    return { message: 'Password changed successfully' };
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
