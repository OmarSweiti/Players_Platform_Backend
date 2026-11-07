import { describe, expect, it } from 'vitest';
import {
  catalogDifferences,
  type StoredGrant,
  type StoredPermission,
} from './catalog-differences';
import { defaultGrants } from './default-role-matrix';
import { PERMISSION_CATALOG, PERMISSION_KEYS } from './permission-catalog';

// What the boot check (0.6.1) reports when the database is not the code's.

const permissions = (): StoredPermission[] =>
  PERMISSION_KEYS.map((name) => {
    const { category, action, description } = PERMISSION_CATALOG[name];
    return { name, category, action, description };
  });
const grants = (): StoredGrant[] =>
  defaultGrants().map(({ role, permission }) => ({ role, permission }));

describe('the stored catalog against the code', () => {
  it('finds_no_difference_in_the_code_own_catalog_and_matrix', () => {
    expect(catalogDifferences(permissions(), grants())).toEqual([]);
  });

  it('names_a_missing_an_unknown_and_a_changed_permission', () => {
    const stored = permissions()
      .filter(({ name }) => name !== 'contract.reject')
      .map((row) =>
        row.name === 'player.read'
          ? { ...row, category: 'MATCH', action: 'EXPORT' }
          : row.name === 'chat.read'
            ? { ...row, description: 'a private remark' }
            : row,
      );
    stored.push({
      name: 'everything.all',
      category: 'TENANT',
      action: 'MANAGE',
      description: null,
    });
    const found = catalogDifferences(stored, grants());
    expect(found).toEqual([
      "chat.read's description is not the catalog's",
      'contract.reject is missing',
      'everything.all is not in the catalog',
      "player.read's action is EXPORT, not READ",
      "player.read's category is MATCH, not PLAYER",
    ]);
    // A stored description is named, never repeated.
    expect(found.join(' ')).not.toContain('a private remark');
  });

  it('names_a_grant_the_matrix_makes_and_one_it_does_not', () => {
    const stored = grants().filter(
      ({ role, permission }) =>
        !(role === 'ADMIN' && permission === 'user.invite'),
    );
    stored.push({ role: 'SUPER_ADMIN', permission: 'medical.read' });
    expect(catalogDifferences(permissions(), stored)).toEqual([
      'ADMIN lacks user.invite',
      'SUPER_ADMIN holds medical.read, which the matrix does not grant',
    ]);
  });
});
