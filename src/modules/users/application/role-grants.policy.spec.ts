import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { mayGrant } from './role-grants.policy';

// Who may give which role (0.5.10): never one above their own.

const ROLES = Object.values(UserRole);
const TENANT_ROLES = ROLES.filter((role) => role !== 'SUPER_ADMIN');

describe('role grants', () => {
  it('an_owner_grants_every_tenant_role', () => {
    expect(TENANT_ROLES.filter((role) => !mayGrant('OWNER', role))).toEqual([]);
  });

  it('an_admin_grants_every_tenant_role_but_ownership', () => {
    expect(ROLES.filter((role) => !mayGrant('ADMIN', role)).sort()).toEqual(
      ['OWNER', 'SUPER_ADMIN'].sort(),
    );
  });

  it('no_other_role_grants_anything', () => {
    const granters = ROLES.filter(
      (role) => role !== 'OWNER' && role !== 'ADMIN',
    );
    const grants = granters.flatMap((granter) =>
      ROLES.filter((role) => mayGrant(granter, role)).map(
        (role) => `${granter} → ${role}`,
      ),
    );
    expect(grants).toEqual([]);
  });

  it('nobody_grants_super_admin', () => {
    expect(ROLES.filter((granter) => mayGrant(granter, 'SUPER_ADMIN'))).toEqual(
      [],
    );
  });
});
