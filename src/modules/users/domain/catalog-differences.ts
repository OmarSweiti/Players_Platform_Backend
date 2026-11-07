// Where the database's permission catalog and default matrix are not the
// code's (0.6.1). The API refuses to boot on any difference
// (src/common/authz/permission-catalog-check.ts), and the catalog's tests
// hold the migrated database to none.

import { defaultGrants } from './default-role-matrix';
import {
  isPermissionKey,
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
} from './permission-catalog';

/** A row of `permissions`, as stored. */
export interface StoredPermission {
  readonly name: string;
  readonly category: string;
  readonly action: string;
  readonly description: string | null;
}

/** A row of `role_permissions`, with its permission's name. */
export interface StoredGrant {
  readonly role: string;
  readonly permission: string;
}

/**
 * Each difference as a sentence that names the permission and the role, never
 * a value beyond the catalog's own; empty when the database is the code's.
 */
export function catalogDifferences(
  permissions: readonly StoredPermission[],
  grants: readonly StoredGrant[],
): string[] {
  const differences: string[] = [];
  const stored = new Map(permissions.map((row) => [row.name, row]));
  for (const key of PERMISSION_KEYS) {
    const row = stored.get(key);
    const entry = PERMISSION_CATALOG[key];
    if (!row) {
      differences.push(`${key} is missing`);
      continue;
    }
    if (row.category !== entry.category) {
      differences.push(
        `${key}'s category is ${row.category}, not ${entry.category}`,
      );
    }
    if (row.action !== entry.action) {
      differences.push(`${key}'s action is ${row.action}, not ${entry.action}`);
    }
    if (row.description !== entry.description) {
      differences.push(`${key}'s description is not the catalog's`);
    }
  }
  for (const name of stored.keys()) {
    if (!isPermissionKey(name))
      differences.push(`${name} is not in the catalog`);
  }

  const grant = ({ role, permission }: StoredGrant) => `${role} ${permission}`;
  const wanted = new Set(defaultGrants().map(grant));
  const held = new Set(grants.map(grant));
  for (const each of wanted) {
    if (!held.has(each)) differences.push(`${each.replace(' ', ' lacks ')}`);
  }
  for (const each of held) {
    if (!wanted.has(each)) {
      differences.push(
        `${each.replace(' ', ' holds ')}, which the matrix does not grant`,
      );
    }
  }
  return differences.sort();
}
