import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../modules/users/domain/permission-catalog';

export const PERMISSIONS_KEY = 'permissions';
/** The catalog's keys only (0.6.1): a permission it does not declare is a compile error. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

// Alias for backward compatibility
export const Permissions = RequirePermissions;
