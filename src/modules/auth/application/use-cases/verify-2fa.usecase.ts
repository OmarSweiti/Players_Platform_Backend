import { Injectable, BadRequestException } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class Verify2FAUseCase {
  constructor(private userRepository: UserRepository) {}

  async execute(userId: string, tenantId: string, token: string) {
    const user = await this.userRepository.findById(userId, tenantId);

    if (!user || !user.twoFASecret) {
      throw new BadRequestException('2FA not initialized');
    }

    if (user.is2FAEnabled) {
      throw new BadRequestException('2FA is already enabled');
    }

    // Verify token
    const verified = speakeasy.totp.verify({
      secret: user.twoFASecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      throw new BadRequestException('Invalid 2FA code');
    }

    // Enable 2FA
    await this.userRepository.update(userId, {
      is2FAEnabled: true,
    });

    return {
      message: '2FA enabled successfully',
      is2FAEnabled: true,
    };
  }
}