import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import type { RequestWithUser } from '../../../../common/interfaces/request-with-user.interface';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

@Injectable()
export class RevokeSessionUseCase {
  private readonly logger = new Logger(RevokeSessionUseCase.name);

  constructor(private userRepository: UserRepository) {}

  async execute(
    req: RequestWithUser,
    sessionId: string,
  ): Promise<{ message: string }> {
    const userId = req.user?.id;
    const tenantId = req.tenantId;

    if (!userId || !tenantId) {
      this.logger.warn(`Session revocation attempted without authentication`);
      throw new BadRequestException('Invalid request');
    }

    // In a stateless JWT system, we can't revoke specific sessions without token blacklisting
    // This would require implementing a token blacklist in Redis or database
    // For now, we'll return a message explaining the limitation

    this.logger.log(
      `Session revocation requested for user ${userId}, session ${sessionId}`,
    );

    // TODO: Implement proper session management with Redis/database
    // For production: Store active tokens in Redis with expiry, check on each request
    // Alternative: Use refresh token rotation and invalidate specific refresh tokens

    return {
      message:
        'Session revocation requires token blacklisting implementation. Please logout from all devices instead.',
    };
  }
}
