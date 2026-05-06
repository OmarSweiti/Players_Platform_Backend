import { Injectable, ConflictException } from '@nestjs/common';
import { UserRepository } from '../../infrastructure/repositories/user.repository';
import { PasswordService } from '../services/password.service';
import { RegisterDto } from '../../presentation/dto/register.dto';

@Injectable()
export class RegisterUseCase {
  constructor(
    private userRepository: UserRepository,
    private passwordService: PasswordService,
  ) {}

  async execute(dto: RegisterDto, tenantId: string) {
    // Check if user already exists
    const existingUser = await this.userRepository.findByEmail(dto.email, tenantId);
    
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Hash password
    const passwordHash = await this.passwordService.hash(dto.password);

    // Create user
    const user = await this.userRepository.create({
      email: dto.email,
      passwordHash,
      role: dto.role,
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      tenantId,
    });

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
}
