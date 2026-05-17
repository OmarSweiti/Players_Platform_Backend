import { Injectable, Logger } from '@nestjs/common';
import type { RequestWithUser } from '../../../../common/interfaces/request-with-user.interface';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class LogoutAllDevicesUseCase {
  private readonly logger = new Logger(LogoutAllDevicesUseCase.name);

  constructor(private userRepository: UserRepository) {}

  async execute(req: RequestWithUser): Promise<{ message: string }> {
    const userId = req.user?.id;
    const tenantId = req.tenantId;

    if (!userId || !tenantId) {
      this.logger.warn(`Logout all devices attempted without authentication`);
      throw new Error('User not authenticated');
    }

    // Update passwordChangedAt timestamp to invalidate all existing JWT tokens
    // This is because JWT validation checks if token was issued before passwordChangedAt
    await this.userRepository.updatePasswordChangedAt(userId, tenantId, new Date());

    this.logger.log(`All sessions invalidated for user ID: ${userId}`);
    
    return {
      message: 'Successfully logged out from all devices',
    };
  }
}
