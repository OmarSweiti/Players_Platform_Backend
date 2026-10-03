import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly mailFrom: string;

  constructor(private config: ConfigService<Env, true>) {
    this.mailFrom = this.config.get('MAIL_FROM', { infer: true });
  }

  /**
   * Send email (placeholder - integrate with actual email provider)
   */
  sendEmail(_to: string, subject: string, _html: string): Promise<void> {
    // No provider is integrated yet, so nothing is delivered — and the log
    // says only that: never the address, never the body, whose links carry
    // single-use tokens.
    this.logger.log(`Not delivered (no mail provider configured): ${subject}`);
    return Promise.resolve();
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verificationLink = `${this.config.get('CORS_ORIGIN', { infer: true })}/verify-email?token=${token}`;
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
    const resetLink = `${this.config.get('CORS_ORIGIN', { infer: true })}/reset-password?token=${token}`;
    const html = `
      <h1>Password Reset</h1>
      <p>Please click the link below to reset your password:</p>
      <a href="${resetLink}">Reset Password</a>
      <p>This link will expire in 1 hour.</p>
    `;

    await this.sendEmail(email, 'Password Reset Request', html);
  }
}
