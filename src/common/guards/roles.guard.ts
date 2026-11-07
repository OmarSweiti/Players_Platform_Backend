import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { UserRole } from '@prisma/client';
import { RequestWithUser } from '../interfaces/request-with-user.interface';
import type { AuthorizedTenantContext } from '../tenancy/tenant-context';
import { PermissionService } from '../../modules/users/application/services/permission.service';
import type { PermissionKey } from '../../modules/users/domain/permission-catalog';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissionService: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const requiredPermissions = this.reflector.getAllAndOverride<
      PermissionKey[]
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    // If no roles or permissions required, allow access
    if (!requiredRoles && !requiredPermissions) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Check role-based access
    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole = requiredRoles.some((role) => user.role === role);

      if (!hasRole) {
        throw new ForbiddenException('Insufficient role permissions');
      }
    }

    // Check permission-based access
    if (requiredPermissions && requiredPermissions.length > 0) {
      // Minted with the member by the session guard (0.5.6): the matrix is
      // read inside the member's tenant transaction.
      const ctx = request.tenantContext;
      if (!ctx) {
        throw new ForbiddenException('User not authenticated');
      }
      const hasPermission = await this.checkPermissions(
        ctx,
        user.role,
        requiredPermissions,
      );

      if (!hasPermission) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }

    return true;
  }

  private async checkPermissions(
    ctx: AuthorizedTenantContext,
    role: UserRole,
    permissions: PermissionKey[],
  ): Promise<boolean> {
    // Check if user has ALL required permissions
    for (const permission of permissions) {
      const hasPerm = await this.permissionService.hasPermission(
        ctx,
        role,
        permission,
      );
      if (!hasPerm) {
        return false;
      }
    }
    return true;
  }
}
