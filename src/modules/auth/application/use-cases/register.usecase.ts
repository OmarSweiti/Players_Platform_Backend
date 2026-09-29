import {
  Injectable,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { PasswordService } from '../services/password.service';
import { MailService } from '../../../../infrastructure/mail/mail.service';
import { RegisterDto } from '../../presentation/dto/register.dto';

@Injectable()
export class RegisterUseCase {
  private readonly logger = new Logger(RegisterUseCase.name);

  constructor(
    private userRepository: UserRepository,
    private passwordService: PasswordService,
    private mailService: MailService,
  ) {}

  async execute(dto: RegisterDto, tenantId: string) {
    const startTime = Date.now();

    try {
      // Check if user already exists
      const existingUser = await this.userRepository.findByEmail(
        dto.email,
        tenantId,
      );

      if (existingUser) {
        this.logger.warn(
          `Registration attempt with existing email: ${dto.email}`,
        );
        throw new ConflictException('User with this email already exists');
      }

      // Validate password strength
      this.validatePasswordStrength(dto.password);

      // Hash password
      const passwordHash = await this.passwordService.hash(dto.password);

      // Generate email verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationTokenExpiry = new Date();
      verificationTokenExpiry.setHours(verificationTokenExpiry.getHours() + 24); // 24 hours

      // Create user
      const user = await this.userRepository.create({
        email: dto.email,
        passwordHash,
        role: dto.role,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        tenantId,
        emailVerificationToken: verificationToken,
        emailVerificationExpiry: verificationTokenExpiry,
      });

      // Send verification email
      await this.mailService.sendVerificationEmail(
        user.email,
        verificationToken,
      );

      const duration = Date.now() - startTime;
      this.logger.log(
        `New user registered: ${user.email} (tenant: ${tenantId}, role: ${user.role}, duration: ${duration}ms)`,
      );

      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
      };
    } catch (error) {
      this.logger.error(
        `Registration failed for ${dto.email}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private validatePasswordStrength(password: string): void {
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password);

    if (password.length < minLength) {
      throw new BadRequestException(
        'Password must be at least 8 characters long',
      );
    }
    if (!hasUpperCase) {
      throw new BadRequestException(
        'Password must contain at least one uppercase letter',
      );
    }
    if (!hasLowerCase) {
      throw new BadRequestException(
        'Password must contain at least one lowercase letter',
      );
    }
    if (!hasNumbers) {
      throw new BadRequestException(
        'Password must contain at least one number',
      );
    }
    if (!hasSpecialChar) {
      throw new BadRequestException(
        'Password must contain at least one special character',
      );
    }
  }
}
