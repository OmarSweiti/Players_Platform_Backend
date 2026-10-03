import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class VerifyEmailUseCase {
  private readonly logger = new Logger(VerifyEmailUseCase.name);

  constructor(private userRepository: UserRepository) {}

  async execute(token: string, tenantId: string) {
    // Find user with valid verification token
    const user = await this.userRepository.findByVerificationToken(
      token,
      tenantId,
    );

    if (!user) {
      this.logger.warn(`Email verification attempted with invalid token`);
      throw new BadRequestException('Invalid or expired verification token');
    }

    // Check if token has expired
    if (
      !user.emailVerificationExpiry ||
      new Date() > user.emailVerificationExpiry
    ) {
      this.logger.warn(
        `Email verification attempted with expired token for user ${user.id}`,
      );
      throw new BadRequestException('Verification token has expired');
    }

    // Update user to mark email as verified
    await this.userRepository.update(user.id, {
      emailVerifiedAt: new Date(),
      emailVerificationToken: null,
      emailVerificationExpiry: null,
    });

    this.logger.log(`Email verified successfully for user ${user.id}`);

    return { message: 'Email verified successfully' };
  }
}
