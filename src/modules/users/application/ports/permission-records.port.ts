import type { UserRole } from '@prisma/client';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { PermissionKey } from '../../domain/permission-catalog';

/**
 * The stored default matrix (0.6.1): reference data every tenant shares,
 * which the API checked against the code's at boot.
 */
export abstract class PermissionRecords {
  /** Whether `role` holds `permission` in the database's matrix. */
  abstract roleHolds(
    tx: TenantTx,
    role: UserRole,
    permission: PermissionKey,
  ): Promise<boolean>;
}
