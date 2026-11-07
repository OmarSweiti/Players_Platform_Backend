import type { Type } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SIGNED_IN_KEY } from '../decorators/signed-in.decorator';
import type { PermissionKey } from '../../modules/users/domain/permission-catalog';

/**
 * Who may call a route (0.6.2; ADR-0005): anyone, any signed-in member on
 * their own session, or a member whose role holds a permission. Every route
 * declares exactly one, on its handler or its controller; the API refuses to
 * start otherwise (route-access-check.ts).
 */
export type RouteAccess =
  | { readonly kind: 'public' }
  | { readonly kind: 'signed-in' }
  | { readonly kind: 'permission'; readonly permission: PermissionKey };

/** Every access rule a route declares: exactly one when it is well declared. */
export function declaredAccess(
  reflector: Reflector,
  handler: (...args: never[]) => unknown,
  controller: Type,
): RouteAccess[] {
  const targets = [handler, controller];
  const declared: RouteAccess[] = [];
  if (reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
    declared.push({ kind: 'public' });
  }
  if (reflector.getAllAndOverride<boolean>(SIGNED_IN_KEY, targets)) {
    declared.push({ kind: 'signed-in' });
  }
  const permission = reflector.getAllAndOverride<PermissionKey | undefined>(
    PERMISSION_KEY,
    targets,
  );
  if (permission) declared.push({ kind: 'permission', permission });
  return declared;
}
