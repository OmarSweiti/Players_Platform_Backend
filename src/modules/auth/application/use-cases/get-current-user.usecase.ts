import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import type { RequestWithUser } from '../../../../common/interfaces/request-with-user.interface';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class GetCurrentUserUseCase {
  private readonly logger = new Logger(GetCurrentUserUseCase.name);

  constructor(private userRepository: UserRepository) {}

  async execute(req: RequestWithUser) {
    const userId = req.user?.id;
    const tenantId = req.tenantId;

    if (!userId || !tenantId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const user = await this.userRepository.findById(userId, tenantId);

    if (!user) {
      this.logger.warn(`Get current user attempted for non-existent user ID: ${userId}`);
      throw new UnauthorizedException('User not found');
    }

    this.logger.debug(`Current user profile retrieved: ${user.email}`);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      emailVerifiedAt: user.emailVerifiedAt,
      is2FAEnabled: user.is2FAEnabled,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
