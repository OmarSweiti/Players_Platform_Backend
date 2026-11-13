// The default role matrix (0.6.1; ADR-0005): which catalog permissions each
// role holds in every tenant. It is the legacy seed's matrix, now stored for
// the first time, less two grants the role matrix of
// docs/reference/security-privacy.md refuses: SUPER_ADMIN's every
// permission, since the platform holds no tenant data (0.6.7), and the owner's
// confidential medical read, since an owner sees medical availability only.
// The medical cells are brought into line with that matrix by 0.6.8, and a
// tenant adjusts its own once per-tenant roles exist (4.1.4). Downloading a
// document, `document.read` (0.8.5), is the owner's and the four roles' that
// upload documents, as the maintainer chose: no player, guardian or coach
// downloads one until it is granted to them.
//
// A permission is an eligibility, never the decision: object policies (0.6.3)
// and confidential projections (0.6.4) still apply. Migrations write the
// matrix as scripts/generate-permission-sync.ts prints it.

import type { PermissionKey } from './permission-catalog';

/** The database's user_role, as the matrix names it. */
export type RoleName =
  | 'SUPER_ADMIN'
  | 'OWNER'
  | 'ADMIN'
  | 'SPORTING_DIRECTOR'
  | 'SCOUT'
  | 'COACH'
  | 'ASSISTANT_COACH'
  | 'GOALKEEPER_COACH'
  | 'FITNESS_COACH'
  | 'MEDICAL'
  | 'PHYSIOTHERAPIST'
  | 'LEGAL'
  | 'FINANCE_MANAGER'
  | 'PERFORMANCE_ANALYST'
  | 'VIDEO_ANALYST'
  | 'TRAINING_MANAGER'
  | 'PLAYER'
  | 'GUARDIAN';

// Every role is named, SUPER_ADMIN's empty: a role the matrix forgot would be
// a compile error, not a member with nothing explained.
export const DEFAULT_ROLE_MATRIX = {
  SUPER_ADMIN: [],

  OWNER: [
    'player.create',
    'player.read',
    'player.update',
    'contract.create',
    'contract.read',
    'contract.approve',
    'training.read',
    'medical.read',
    'scouting.read',
    'match.read',
    'finance.read',
    'finance.export',
    'legal.read',
    'user.read',
    'user.invite',
    'tenant.manage',
    'report.view',
    'report.export',
    'document.read',
    'chat.read',
  ],

  ADMIN: [
    'player.create',
    'player.read',
    'player.update',
    'contract.create',
    'contract.read',
    'training.create',
    'training.read',
    'training.update',
    'medical.read',
    'scouting.read',
    'match.read',
    'legal.create',
    'legal.read',
    'user.create',
    'user.read',
    'user.update',
    'user.invite',
    'report.view',
    'document.upload',
    'document.read',
    'chat.send',
    'chat.read',
  ],

  SPORTING_DIRECTOR: [
    'player.read',
    'player.update',
    'contract.read',
    'contract.approve',
    'scouting.create',
    'scouting.read',
    'scouting.update',
    'scouting.report.create',
    'scouting.report.read',
    'scouting.report.update',
    'scouting.report.delete',
    'scouting.report.submit',
    'scouting.report.approve',
    'scouting.report.reject',
    'scouting.watchlist.view',
    'scouting.watchlist.manage',
    'scouting.assignment.view',
    'scouting.assignment.manage',
    'scouting.assignment.update',
    'match.read',
    'training.read',
    'performance.read',
    'report.view',
    'report.export',
  ],

  SCOUT: [
    'player.read',
    'scouting.create',
    'scouting.read',
    'scouting.update',
    'scouting.report.create',
    'scouting.report.read',
    'scouting.report.update',
    'scouting.report.submit',
    'scouting.watchlist.view',
    'scouting.watchlist.manage',
    'scouting.assignment.view',
    'scouting.assignment.update',
    'document.upload',
    'document.read',
  ],

  COACH: [
    'player.read',
    'training.create',
    'training.read',
    'training.update',
    'match.read',
    'match.update',
    'performance.read',
    'chat.send',
    'chat.read',
  ],

  ASSISTANT_COACH: [
    'player.read',
    'training.read',
    'training.update',
    'match.read',
  ],

  GOALKEEPER_COACH: ['player.read', 'training.create', 'training.read'],

  FITNESS_COACH: [
    'player.read',
    'training.create',
    'training.read',
    'medical.read',
  ],

  MEDICAL: [
    'player.read',
    'medical.create',
    'medical.read',
    'medical.update',
    'medical.view_confidential',
    'training.read',
  ],

  PHYSIOTHERAPIST: [
    'player.read',
    'medical.create',
    'medical.read',
    'medical.update',
  ],

  LEGAL: [
    'contract.read',
    'contract.approve',
    'legal.create',
    'legal.read',
    'legal.update',
    'legal.approve',
    'document.upload',
    'document.read',
  ],

  FINANCE_MANAGER: [
    'contract.read',
    'finance.read',
    'finance.manage',
    'finance.export',
    'report.view',
  ],

  PERFORMANCE_ANALYST: [
    'player.read',
    'match.read',
    'performance.create',
    'performance.read',
    'report.view',
    'report.export',
  ],

  VIDEO_ANALYST: [
    'player.read',
    'match.read',
    'document.upload',
    'document.read',
    'report.view',
  ],

  TRAINING_MANAGER: [
    'player.read',
    'training.create',
    'training.read',
    'training.update',
    'training.delete',
    'training.assign',
  ],

  // "Own" and "linked" are relationships, which the object policies read
  // (0.6.3, 0.6.5): a permission alone reaches no one's record.
  PLAYER: [
    'player.read',
    'contract.read',
    'training.read',
    'medical.read',
    'chat.send',
    'chat.read',
  ],

  GUARDIAN: ['player.read', 'training.read'],
} as const satisfies Record<RoleName, readonly PermissionKey[]>;

export interface DefaultGrant {
  readonly role: RoleName;
  readonly permission: PermissionKey;
}

/** Every grant the matrix makes, in its own order: by role as listed, then by permission as listed. */
export function defaultGrants(): readonly DefaultGrant[] {
  return (
    Object.entries(DEFAULT_ROLE_MATRIX) as [
      RoleName,
      readonly PermissionKey[],
    ][]
  ).flatMap(([role, permissions]) =>
    permissions.map((permission) => ({ role, permission })),
  );
}
