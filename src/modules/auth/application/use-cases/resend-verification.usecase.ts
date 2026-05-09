import { Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { MailService } from '../../../../infrastructure/mail/mail.service';

@Injectable()
export class ResendVerificationUseCase {
  constructor(
    private userRepository: UserRepository,
    private mailService: MailService,
  ) {}

  async execute(email: string, tenantId: string) {
    const user = await this.userRepository.findByEmail(email, tenantId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if email is already verified
    if (user.emailVerifiedAt) {
      return { message: 'Email is already verified' };
    }

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpiry = new Date();
    verificationTokenExpiry.setHours(verificationTokenExpiry.getHours() + 24); // 24 hours

    // Update user with new token
    await this.userRepository.update(user.id, {
      emailVerificationToken: verificationToken,
      emailVerificationExpiry: verificationTokenExpiry,
    });

    // Send verification email
    await this.mailService.sendVerificationEmail(user.email, verificationToken);

    return { message: 'Verification email sent successfully' };
  }
}
