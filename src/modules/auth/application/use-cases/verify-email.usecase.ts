import { Injectable, BadRequestException } from '@nestjs/common';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class VerifyEmailUseCase {
  constructor(private userRepository: UserRepository) {}

  async execute(token: string, tenantId: string) {
    // Find user with valid verification token
    const user = await this.userRepository.findByVerificationToken(token, tenantId);

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    // Check if token has expired
    if (!user.emailVerificationExpiry || new Date() > user.emailVerificationExpiry) {
      throw new BadRequestException('Verification token has expired');
    }

    // Update user to mark email as verified
    await this.userRepository.update(user.id, {
      emailVerifiedAt: new Date(),
      emailVerificationToken: null,
      emailVerificationExpiry: null,
    });

    return { message: 'Email verified successfully' };
  }
}
