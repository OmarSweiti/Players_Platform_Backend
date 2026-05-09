import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { RequestWithUser } from '../../../../common/interfaces/request-with-user.interface';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class GetCurrentUserUseCase {
  constructor(private userRepository: UserRepository) {}

  async execute(req: RequestWithUser) {
    const userId = req.user?.id;
    const tenantId = req.tenantId;

    if (!userId || !tenantId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const user = await this.userRepository.findById(userId, tenantId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

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
