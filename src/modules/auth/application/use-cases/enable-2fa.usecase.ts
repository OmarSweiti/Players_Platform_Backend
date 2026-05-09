import { Injectable } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class Enable2FAUseCase {
  constructor(private userRepository: UserRepository) {}

  async execute(userId: string, tenantId: string) {
    // Generate 2FA secret
    const secret = speakeasy.generateSecret({
      length: 32,
      name: `Players Platform (${userId})`,
      issuer: 'Players Platform',
    });

    // Generate QR code
    const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url || '');

    // Store secret temporarily (not enabled yet - needs verification)
    await this.userRepository.update(userId, {
      twoFASecret: secret.base32,
      is2FAEnabled: false,
    });

    return {
      secret: secret.base32,
      qrCode: qrCodeDataUrl,
      message: 'Scan QR code and verify to enable 2FA',
    };
  }
}
