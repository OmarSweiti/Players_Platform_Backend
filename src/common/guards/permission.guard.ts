import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { declaredAccess } from '../authz/route-access';
import { ForbiddenError } from '../errors/domain-error';
import type { RequestWithUser } from '../interfaces/request-with-user.interface';
import { PermissionService } from '../../modules/users/application/services/permission.service';

/**
 * Deny by default (0.6.2; ADR-0005). A route that requires a permission is
 * served only to a member whose role holds it; a @SignedIn() route to any
 * member the session guard let through; a @Public() route to anyone. A route
 * that declares none, or more than one, is refused — the API does not start
 * with one (route-access-check.ts), and this guard fails closed all the same.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = declaredAccess(
      this.reflector,
      context.getHandler() as (...args: never[]) => unknown,
      context.getClass(),
    );
    if (declared.length !== 1) {
      throw new ForbiddenError('the route declares no single access rule');
    }
    const [access] = declared;
    if (access.kind !== 'permission') return true;

    // The session guard minted the member's context (0.5.6): the matrix is
    // read inside their tenant transaction.
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const ctx = request.tenantContext;
    if (!ctx) throw new ForbiddenError('no signed-in member');
    const holds = await this.permissions.hasPermission(
      ctx,
      request.user.role,
      access.permission,
    );
    if (!holds) {
      throw new ForbiddenError(`the role does not hold ${access.permission}`);
    }
    return true;
  }
}
