import { Injectable, Logger } from '@nestjs/common';
import type { RequestWithUser } from '../../../../common/interfaces/request-with-user.interface';
import { UserRepository } from '../../infrastructure/repositories/user.repository';

export interface ActiveSession {
  id: string;
  deviceInfo: string;
  ipAddress: string;
  lastAccessedAt: Date;
  createdAt: Date;
  isCurrent: boolean;
}

@Injectable()
export class GetActiveSessionsUseCase {
  private readonly logger = new Logger(GetActiveSessionsUseCase.name);

  constructor(private userRepository: UserRepository) {}

  execute(req: RequestWithUser): Promise<ActiveSession[]> {
    const userId = req.user?.id;
    const tenantId = req.tenantId;

    if (!userId || !tenantId) {
      this.logger.warn(`Get active sessions attempted without authentication`);
      return Promise.resolve([]);
    }

    // For now, return a single session since we're using stateless JWT
    // In a production system, you would track sessions in a database or Redis
    this.logger.debug(`Active sessions retrieved for user ID: ${userId}`);

    return Promise.resolve([
      {
        id: 'current-session',
        deviceInfo: 'Current Browser',
        ipAddress: 'Unknown',
        lastAccessedAt: new Date(),
        createdAt: new Date(),
        isCurrent: true,
      },
    ]);
  }
}
