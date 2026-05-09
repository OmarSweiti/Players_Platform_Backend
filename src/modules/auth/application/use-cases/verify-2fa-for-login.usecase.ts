import { Injectable, BadRequestException } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

export interface Verify2FAForLoginDto {
  userId: string;
  token: string;
  tenantId: string;
}

@Injectable()
export class Verify2FAForLoginUseCase {
  constructor(private userRepository: UserRepository) {}

  async execute(dto: Verify2FAForLoginDto) {
    const user = await this.userRepository.findById(dto.userId, dto.tenantId);

    if (!user || !user.twoFASecret || !user.is2FAEnabled) {
      throw new BadRequestException('2FA is not enabled for this account');
    }

    // Verify token
    const verified = speakeasy.totp.verify({
      secret: user.twoFASecret,
      encoding: 'base32',
      token: dto.token,
      window: 1, // Allow 1 step before/after for clock drift
    });

    if (!verified) {
      throw new BadRequestException('Invalid 2FA code');
    }

    return {
      message: '2FA verification successful',
      verified: true,
    };
  }
}
