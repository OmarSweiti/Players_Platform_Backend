import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../modules/users/domain/permission-catalog';

export const PERMISSION_KEY = 'permission';

/**
 * The one permission a route requires (0.6.2): the signed-in member's role
 * must hold it in the default matrix, read from the database on every
 * request. A catalog key only, so an undeclared permission does not compile.
 */
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(PERMISSION_KEY, permission);
