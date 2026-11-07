import { Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { PermissionRecords } from '../../application/ports/permission-records.port';
import type { PermissionKey } from '../../domain/permission-catalog';

@Injectable()
export class PermissionRepository extends PermissionRecords {
  async roleHolds(
    tx: TenantTx,
    role: UserRole,
    permission: PermissionKey,
  ): Promise<boolean> {
    // permissions and role_permissions belong to no tenant: row-level
    // security does not filter them, so every tenant reads the same matrix.
    const grant = await tx.rolePermission.findFirst({
      where: { roleId: role, permission: { name: permission } },
      select: { id: true },
    });
    return grant !== null;
  }
}
