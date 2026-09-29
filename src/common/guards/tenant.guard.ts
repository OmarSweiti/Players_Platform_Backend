import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RequestWithUser } from '../interfaces/request-with-user.interface';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    // Get tenantId from authenticated user
    if (!user?.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Set tenant context for automatic isolation
    request.tenantId = user.tenantId;

    return true;
  }
}
