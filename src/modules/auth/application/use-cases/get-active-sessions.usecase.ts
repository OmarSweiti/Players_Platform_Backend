import { Injectable } from '@nestjs/common';
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
  constructor(private userRepository: UserRepository) {}

  async execute(req: RequestWithUser): Promise<ActiveSession[]> {
    const userId = req.user?.id;
    const tenantId = req.tenantId;

    if (!userId || !tenantId) {
      return [];
    }

    // For now, return a single session since we're using stateless JWT
    // In a production system, you would track sessions in a database or Redis
    return [
      {
        id: 'current-session',
        deviceInfo: 'Current Browser',
        ipAddress: 'Unknown',
        lastAccessedAt: new Date(),
        createdAt: new Date(),
        isCurrent: true,
      },
    ];
  }
}
