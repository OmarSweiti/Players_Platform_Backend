import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_MATRIX,
  defaultGrants,
  type RoleName,
} from './default-role-matrix';
import { PERMISSION_CATALOG, PERMISSION_KEYS } from './permission-catalog';

// The default matrix (0.6.1). Which roles may hold a confidential grant is
// written out here from docs/reference/security-privacy.md's role matrix —
// "full data explicit" for medical and physiotherapy staff — apart from the
// matrix it checks.
const ELIGIBLE_FOR: Record<string, readonly RoleName[]> = {
  'medical.view_confidential': ['MEDICAL', 'PHYSIOTHERAPIST'],
};

describe('the default role matrix', () => {
  it('names_every_role_of_the_database_and_no_other', () => {
    expect(Object.keys(DEFAULT_ROLE_MATRIX).sort()).toEqual(
      Object.values(UserRole).sort(),
    );
  });

  it('grants_super_admin_nothing', () => {
    expect(DEFAULT_ROLE_MATRIX.SUPER_ADMIN).toEqual([]);
  });

  it('lists_each_permission_once_per_role', () => {
    for (const [role, permissions] of Object.entries(DEFAULT_ROLE_MATRIX)) {
      expect([role, new Set(permissions).size]).toEqual([
        role,
        permissions.length,
      ]);
    }
  });

  it('grants_a_confidential_permission_only_to_a_role_eligible_for_it', () => {
    const confidential = PERMISSION_KEYS.filter(
      (key) => PERMISSION_CATALOG[key].confidential,
    );
    expect(confidential.sort()).toEqual(Object.keys(ELIGIBLE_FOR).sort());
    for (const { role, permission } of defaultGrants()) {
      if (!PERMISSION_CATALOG[permission].confidential) continue;
      expect([permission, ELIGIBLE_FOR[permission].includes(role)]).toEqual([
        permission,
        true,
      ]);
    }
    expect(DEFAULT_ROLE_MATRIX.OWNER).not.toContain(
      'medical.view_confidential',
    );
  });

  it('lists_its_grants_role_by_role_in_its_own_order', () => {
    const grants = defaultGrants();
    expect(grants.length).toBe(
      Object.values(DEFAULT_ROLE_MATRIX).reduce((n, p) => n + p.length, 0),
    );
    expect(grants[0]).toEqual({ role: 'OWNER', permission: 'player.create' });
    expect(grants.at(-1)).toEqual({
      role: 'GUARDIAN',
      permission: 'training.read',
    });
  });
});
