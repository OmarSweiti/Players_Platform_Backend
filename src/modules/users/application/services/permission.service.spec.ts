import type { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type {
  TenantTransactions,
  TenantTx,
} from '../../../../common/tenancy/tenant-transaction';
import { PERMISSION_KEYS } from '../../domain/permission-catalog';
import { PermissionRecords } from '../ports/permission-records.port';
import { PermissionService } from './permission.service';

// The effective permissions the session lists (0.6.6). The stored matrix is
// test/authz/effective-permissions.e2e-spec.ts's, against PostgreSQL; here,
// the order and who holds none.

/** A stored matrix of one role, in the order the database happens to return it. */
class StoredMatrix extends PermissionRecords {
  readonly asked: UserRole[] = [];

  constructor(private readonly names: readonly string[]) {
    super();
  }

  roleHolds(): Promise<boolean> {
    return expect.unreachable('the effective permissions are one read');
  }

  permissionsOf(_tx: TenantTx, role: UserRole): Promise<readonly string[]> {
    this.asked.push(role);
    return Promise.resolve(this.names);
  }
}

/** The tenant transaction, as the unit sees it: the work runs once. */
const transactions = {
  withTenantTransaction: <T>(
    _ctx: AuthorizedTenantContext,
    work: (tx: TenantTx) => Promise<T>,
  ) => work({} as TenantTx),
} as unknown as TenantTransactions;

/** A context as the session guard mints one; the service reads its actor only. */
function memberContext(role: UserRole) {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    actor: {
      kind: 'USER',
      userId: '00000000-0000-4000-8000-000000000003',
      sessionId: '00000000-0000-4000-8000-000000000002',
      role,
    },
    requestId: 'request',
    locale: 'en',
  } as unknown as AuthorizedTenantContext;
}

const job = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  actor: { kind: 'SYSTEM', job: 'a-job' },
  requestId: 'request',
  locale: 'en',
} as unknown as AuthorizedTenantContext;

describe('the effective permissions of a member', () => {
  it('effective_permissions_follow_the_catalogs_order', async () => {
    const held = ['medical.read', 'player.read', 'chat.send'] as const;
    const stored = new StoredMatrix([...held].reverse());
    const service = new PermissionService(transactions, stored);

    const listed = await service.effectivePermissions(memberContext('COACH'));

    expect(listed).toEqual(
      PERMISSION_KEYS.filter((key) =>
        (held as readonly string[]).includes(key),
      ),
    );
    // The role is the context's, as the session guard minted it.
    expect(stored.asked).toEqual(['COACH']);
  });

  it('a_job_holds_no_effective_permission', async () => {
    const stored = new StoredMatrix(['player.read']);
    const service = new PermissionService(transactions, stored);

    expect(await service.effectivePermissions(job)).toEqual([]);
    expect(stored.asked).toEqual([]);
  });
});
