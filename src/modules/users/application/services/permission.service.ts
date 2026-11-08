import { Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import {
  CONFIDENTIAL_CLASSES,
  type ConfidentialClass,
} from '../../../../common/policy/confidential-class';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { CONFIDENTIAL_GRANTS } from '../../domain/confidential-grants';
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

  /**
   * The confidential classes whose explicit grant the member's role holds
   * (0.6.4; domain/confidential-grants.ts): what a resource's policy may then
   * disclose to them (`disclosedClasses`). The role is the context's, as the
   * session guard minted it; a job holds none.
   */
  async grantedClasses(
    ctx: AuthorizedTenantContext,
  ): Promise<ReadonlySet<ConfidentialClass>> {
    const { actor } = ctx;
    if (actor.kind !== 'USER') return new Set();
    const held = await this.transactions.withTenantTransaction(
      ctx,
      async (tx) => {
        const granted: ConfidentialClass[] = [];
        for (const confidentialClass of CONFIDENTIAL_CLASSES) {
          const grant = CONFIDENTIAL_GRANTS[confidentialClass];
          if (grant && (await this.records.roleHolds(tx, actor.role, grant))) {
            granted.push(confidentialClass);
          }
        }
        return granted;
      },
    );
    return new Set(held);
  }
}
