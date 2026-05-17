import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class Disable2FAUseCase {
  private readonly logger = new Logger(Disable2FAUseCase.name);

  constructor(private userRepository: UserRepository) {}

  async execute(userId: string, tenantId: string, token: string) {
    const user = await this.userRepository.findById(userId, tenantId);

    if (!user || !user.is2FAEnabled) {
      this.logger.warn(`2FA disable attempted but not enabled for user ID: ${userId}`);
      throw new BadRequestException('2FA is not enabled');
    }

    if (!user.twoFASecret) {
      this.logger.warn(`2FA disable attempted but secret not found for user: ${user.email}`);
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
      this.logger.warn(`Invalid 2FA code provided when disabling for user: ${user.email}`);
      throw new BadRequestException('Invalid 2FA code');
    }

    // Disable 2FA
    await this.userRepository.update(userId, {
      is2FAEnabled: false,
      twoFASecret: null,
    });

    this.logger.log(`2FA disabled successfully for user: ${user.email}`);

    return {
      message: '2FA disabled successfully',
      is2FAEnabled: false,
    };
  }
}
