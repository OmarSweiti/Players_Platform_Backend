import { Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import type { PermissionKey } from '../../domain/permission-catalog';
import { PermissionRecords } from '../ports/permission-records.port';

/**
 * The permissions a member's role holds (0.6.1): the default role matrix
 * (domain/default-role-matrix.ts), read from the database on every request,
 * where the migrations wrote it and the API checked it at boot.
 */
@Injectable()
export class PermissionService {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: PermissionRecords,
  ) {}

  /** Whether `role` holds `permission`: an eligibility, which object policies still decide on (0.6.3). */
  hasPermission(
    ctx: AuthorizedTenantContext,
    role: UserRole,
    permission: PermissionKey,
  ): Promise<boolean> {
    return this.transactions.withTenantTransaction(ctx, (tx) =>
      this.records.roleHolds(tx, role, permission),
    );
  }
}
