import { Injectable, BadRequestException } from '@nestjs/common';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class Disable2FAUseCase {
  constructor(private userRepository: UserRepository) {}

  async execute(userId: string, tenantId: string, token: string) {
    const user = await this.userRepository.findById(userId, tenantId);

    if (!user || !user.is2FAEnabled) {
      throw new BadRequestException('2FA is not enabled');
    }

    if (!user.twoFASecret) {
      throw new BadRequestException('2FA secret not found');
    }

    // Verify token before disabling
    const speakeasy = await import('speakeasy');
    const verified = speakeasy.default.totp.verify({
      secret: user.twoFASecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      throw new BadRequestException('Invalid 2FA code');
    }

    // Disable 2FA
    await this.userRepository.update(userId, {
      is2FAEnabled: false,
      twoFASecret: null,
    });

    return {
      message: '2FA disabled successfully',
      is2FAEnabled: false,
    };
  }
}
