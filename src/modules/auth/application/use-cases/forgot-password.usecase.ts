import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { MailService } from '../../../../infrastructure/mail/mail.service';
import { ForgotPasswordDto } from '../../presentation/dto/forgot-password.dto';

@Injectable()
export class ForgotPasswordUseCase {
  private readonly logger = new Logger(ForgotPasswordUseCase.name);

  constructor(
    private userRepository: UserRepository,
    private mailService: MailService,
  ) {}

  async execute(dto: ForgotPasswordDto, tenantId: string) {
    const user = await this.userRepository.findByEmail(dto.email, tenantId);

    // Always return success to prevent email enumeration
    if (!user) {
      this.logger.log(
        `Password reset requested for non-existent email: ${dto.email}`,
      );
      return {
        message:
          'If an account exists with this email, a password reset link has been sent',
      };
    }

    // Generate secure reset token (expires in 1 hour)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date();
    resetTokenExpiry.setHours(resetTokenExpiry.getHours() + 1);

    // Store hashed token in database
    const hashedToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    await this.userRepository.update(user.id, {
      passwordResetToken: hashedToken,
      passwordResetExpiry: resetTokenExpiry,
    });

    // Send reset email
    await this.mailService.sendPasswordResetEmail(user.email, resetToken);

    this.logger.log(`Password reset email sent to: ${user.email}`);

    return {
      message:
        'If an account exists with this email, a password reset link has been sent',
    };
  }
}
