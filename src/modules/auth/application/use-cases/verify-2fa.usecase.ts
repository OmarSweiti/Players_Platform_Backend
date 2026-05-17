import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class Verify2FAUseCase {
  private readonly logger = new Logger(Verify2FAUseCase.name);

  constructor(private userRepository: UserRepository) {}

  async execute(userId: string, tenantId: string, token: string) {
    const user = await this.userRepository.findById(userId, tenantId);

    if (!user || !user.twoFASecret) {
      this.logger.warn(`2FA verification attempted but not initialized for user ID: ${userId}`);
      throw new BadRequestException('2FA not initialized');
    }

    if (user.is2FAEnabled) {
      this.logger.warn(`2FA verification attempted but already enabled for user: ${user.email}`);
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
      this.logger.warn(`Invalid 2FA code provided for user: ${user.email}`);
      throw new BadRequestException('Invalid 2FA code');
    }

    // Enable 2FA
    await this.userRepository.update(userId, {
      is2FAEnabled: true,
    });

    this.logger.log(`2FA enabled successfully for user: ${user.email}`);

    return {
      message: '2FA enabled successfully',
      is2FAEnabled: true,
    };
  }
}