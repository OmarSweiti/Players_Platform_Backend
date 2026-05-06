import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly mailFrom: string;

  constructor(private configService: ConfigService) {
    this.mailFrom = this.configService.get<string>('MAIL_FROM') || 'noreply@example.com';
  }

  /**
   * Send email (placeholder - integrate with actual email provider)
   */
  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    this.logger.log(`Sending email to ${to} with subject: ${subject}`);
    
    // TODO: Integrate with actual email service (SendGrid, AWS SES, etc.)
    // For now, just log the email
    this.logger.debug(`From: ${this.mailFrom}, To: ${to}, Subject: ${subject}`);
    this.logger.debug(`HTML: ${html}`);
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verificationLink = `${this.configService.get('CORS_ORIGIN')}/verify-email?token=${token}`;
    const html = `
      <h1>Email Verification</h1>
      <p>Please click the link below to verify your email:</p>
      <a href="${verificationLink}">Verify Email</a>
    `;
    
    await this.sendEmail(email, 'Verify Your Email', html);
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const resetLink = `${this.configService.get('CORS_ORIGIN')}/reset-password?token=${token}`;
    const html = `
      <h1>Password Reset</h1>
      <p>Please click the link below to reset your password:</p>
      <a href="${resetLink}">Reset Password</a>
      <p>This link will expire in 1 hour.</p>
    `;
    
    await this.sendEmail(email, 'Password Reset Request', html);
  }
}
