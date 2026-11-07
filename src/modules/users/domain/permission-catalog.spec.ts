import { PermissionAction, PermissionCategory } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  isPermissionKey,
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
} from './permission-catalog';

// The catalog (0.6.1), held to what it must keep: every permission the legacy
// constants named — written out here, apart from the catalog, so that a
// dropped entry fails — each storable in the database's enums.

const LEGACY_PERMISSIONS = [
  'player.create', 'player.read', 'player.update', 'player.delete', 'player.export',
  'contract.create', 'contract.read', 'contract.update', 'contract.delete', 'contract.approve', 'contract.reject',
  'training.create', 'training.read', 'training.update', 'training.delete', 'training.assign',
  'medical.create', 'medical.read', 'medical.update', 'medical.view_confidential',
  'scouting.create', 'scouting.read', 'scouting.update', 'scouting.delete',
  'scouting.report.create', 'scouting.report.read', 'scouting.report.update', 'scouting.report.delete',
  'scouting.report.submit', 'scouting.report.approve', 'scouting.report.reject',
  'scouting.watchlist.view', 'scouting.watchlist.manage',
  'scouting.assignment.view', 'scouting.assignment.manage', 'scouting.assignment.update',
  'match.create', 'match.read', 'match.update', 'match.delete',
  'finance.read', 'finance.manage', 'finance.export',
  'legal.create', 'legal.read', 'legal.update', 'legal.approve',
  'user.create', 'user.read', 'user.update', 'user.delete', 'user.assign_role', 'user.invite',
  'tenant.manage',
  'report.view', 'report.export',
  'document.upload', 'document.delete',
  'chat.send', 'chat.read', 'chat.delete',
  'performance.create', 'performance.read', 'performance.update',
]; // prettier-ignore

describe('the permission catalog', () => {
  it('holds_every_legacy_permission_once_and_nothing_else', () => {
    expect(new Set(LEGACY_PERMISSIONS).size).toBe(64);
    expect([...PERMISSION_KEYS].sort()).toEqual([...LEGACY_PERMISSIONS].sort());
  });

  it('declares_each_category_and_action_from_the_database_enums', () => {
    const categories: readonly string[] = Object.values(PermissionCategory);
    const actions: readonly string[] = Object.values(PermissionAction);
    for (const key of PERMISSION_KEYS) {
      const { category, action } = PERMISSION_CATALOG[key];
      expect([key, categories.includes(category)]).toEqual([key, true]);
      expect([key, actions.includes(action)]).toEqual([key, true]);
    }
  });

  it('fits_each_key_and_description_in_its_column', () => {
    for (const key of PERMISSION_KEYS) {
      expect(key.length).toBeLessThanOrEqual(100); // name VARCHAR(100)
      const { description } = PERMISSION_CATALOG[key];
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(255); // VARCHAR(255)
    }
  });

  it('marks_only_the_confidential_medical_read_as_a_confidential_grant', () => {
    expect(
      PERMISSION_KEYS.filter((key) => PERMISSION_CATALOG[key].confidential),
    ).toEqual(['medical.view_confidential']);
  });

  it('knows_its_own_keys_and_no_others', () => {
    expect(isPermissionKey('contract.approve')).toBe(true);
    expect(isPermissionKey('contract.sign')).toBe(false);
    expect(isPermissionKey('toString')).toBe(false);
  });
});
