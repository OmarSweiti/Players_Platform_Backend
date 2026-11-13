// The permission catalog (0.6.1; ADR-0005): every permission the API knows.
// Each entry declares its category, its action and whether it is a
// confidential grant; nothing is parsed from its key. Migrations write it to
// the database as scripts/generate-permission-sync.ts prints it, and the API
// refuses to boot when the database holds anything else
// (src/common/authz/permission-catalog-check.ts).

/** The database's permission_category, as the catalog names it. */
export type PermissionCategory =
  | 'PLAYER'
  | 'CONTRACT'
  | 'TRAINING'
  | 'MEDICAL'
  | 'SCOUTING'
  | 'MATCH'
  | 'FINANCE'
  | 'LEGAL'
  | 'CHAT'
  | 'USER'
  | 'TENANT'
  | 'REPORT'
  | 'DOCUMENT'
  | 'NOTIFICATION'
  | 'PERFORMANCE';

/** The database's permission_action, as the catalog names it. */
export type PermissionAction =
  | 'CREATE'
  | 'READ'
  | 'UPDATE'
  | 'DELETE'
  | 'APPROVE'
  | 'EXPORT'
  | 'IMPORT'
  | 'ASSIGN'
  | 'VIEW_CONFIDENTIAL'
  | 'MANAGE'
  | 'INVITE'
  | 'REJECT'
  | 'SUBMIT';

export interface PermissionDefinition {
  readonly category: PermissionCategory;
  /**
   * What the permission does, in the vocabulary of SR-ACL-004. A key's verb
   * is not always the action's name: viewing is READ, uploading a document or
   * sending a message is CREATE, and assigning a role is ASSIGN.
   */
  readonly action: PermissionAction;
  /**
   * A confidential grant: the explicit permission that the role matrix of
   * docs/reference/security-privacy.md requires before a confidential class
   * is read. Only medical's exists today; the grants for compensation,
   * internal legal notes and identity documents arrive with the steps that
   * build those reads.
   */
  readonly confidential: boolean;
  /** For a person reading the catalog: a short English phrase. */
  readonly description: string;
}

const operational = (
  category: PermissionCategory,
  action: PermissionAction,
  description: string,
): PermissionDefinition => ({
  category,
  action,
  confidential: false,
  description,
});

// An object literal: a key cannot appear twice.
export const PERMISSION_CATALOG = {
  'player.create': operational('PLAYER', 'CREATE', 'Create a player'),
  'player.read': operational('PLAYER', 'READ', 'Read players'),
  'player.update': operational('PLAYER', 'UPDATE', 'Update a player'),
  'player.delete': operational('PLAYER', 'DELETE', 'Delete a player'),
  'player.export': operational('PLAYER', 'EXPORT', 'Export players'),

  'contract.create': operational('CONTRACT', 'CREATE', 'Create a contract'),
  'contract.read': operational('CONTRACT', 'READ', 'Read contracts'),
  'contract.update': operational('CONTRACT', 'UPDATE', 'Update a contract'),
  'contract.delete': operational('CONTRACT', 'DELETE', 'Delete a contract'),
  'contract.approve': operational('CONTRACT', 'APPROVE', 'Approve a contract'),
  'contract.reject': operational('CONTRACT', 'REJECT', 'Reject a contract'),

  'training.create': operational(
    'TRAINING',
    'CREATE',
    'Create a training program',
  ),
  'training.read': operational('TRAINING', 'READ', 'Read training programs'),
  'training.update': operational(
    'TRAINING',
    'UPDATE',
    'Update a training program',
  ),
  'training.delete': operational(
    'TRAINING',
    'DELETE',
    'Delete a training program',
  ),
  'training.assign': operational(
    'TRAINING',
    'ASSIGN',
    'Enrol players in a training program',
  ),

  'medical.create': operational('MEDICAL', 'CREATE', 'Create a medical record'),
  'medical.read': operational('MEDICAL', 'READ', 'Read medical records'),
  'medical.update': operational('MEDICAL', 'UPDATE', 'Update a medical record'),
  'medical.view_confidential': {
    category: 'MEDICAL',
    action: 'VIEW_CONFIDENTIAL',
    confidential: true,
    description: 'Read confidential medical records',
  },

  'scouting.create': operational(
    'SCOUTING',
    'CREATE',
    'Create scouting records',
  ),
  'scouting.read': operational('SCOUTING', 'READ', 'Read scouting records'),
  'scouting.update': operational(
    'SCOUTING',
    'UPDATE',
    'Update scouting records',
  ),
  'scouting.delete': operational(
    'SCOUTING',
    'DELETE',
    'Delete scouting records',
  ),
  'scouting.report.create': operational(
    'SCOUTING',
    'CREATE',
    'Write a scouting report',
  ),
  'scouting.report.read': operational(
    'SCOUTING',
    'READ',
    'Read scouting reports',
  ),
  'scouting.report.update': operational(
    'SCOUTING',
    'UPDATE',
    'Edit a scouting report',
  ),
  'scouting.report.delete': operational(
    'SCOUTING',
    'DELETE',
    'Delete a scouting report',
  ),
  'scouting.report.submit': operational(
    'SCOUTING',
    'SUBMIT',
    'Submit a scouting report for review',
  ),
  'scouting.report.approve': operational(
    'SCOUTING',
    'APPROVE',
    'Approve a scouting report',
  ),
  'scouting.report.reject': operational(
    'SCOUTING',
    'REJECT',
    'Reject a scouting report',
  ),
  'scouting.watchlist.view': operational(
    'SCOUTING',
    'READ',
    'View scouting watchlists',
  ),
  'scouting.watchlist.manage': operational(
    'SCOUTING',
    'MANAGE',
    'Manage scouting watchlists',
  ),
  'scouting.assignment.view': operational(
    'SCOUTING',
    'READ',
    'View scouting assignments',
  ),
  'scouting.assignment.manage': operational(
    'SCOUTING',
    'MANAGE',
    'Assign scouting work',
  ),
  'scouting.assignment.update': operational(
    'SCOUTING',
    'UPDATE',
    'Update a scouting assignment',
  ),

  'match.create': operational('MATCH', 'CREATE', 'Create a match'),
  'match.read': operational('MATCH', 'READ', 'Read matches'),
  'match.update': operational('MATCH', 'UPDATE', 'Update a match'),
  'match.delete': operational('MATCH', 'DELETE', 'Delete a match'),

  'finance.read': operational('FINANCE', 'READ', 'Read finance records'),
  'finance.manage': operational('FINANCE', 'MANAGE', 'Manage finance records'),
  'finance.export': operational('FINANCE', 'EXPORT', 'Export finance records'),

  'legal.create': operational('LEGAL', 'CREATE', 'Create legal records'),
  'legal.read': operational('LEGAL', 'READ', 'Read legal records'),
  'legal.update': operational('LEGAL', 'UPDATE', 'Update legal records'),
  'legal.approve': operational('LEGAL', 'APPROVE', 'Approve legal requests'),

  'user.create': operational('USER', 'CREATE', 'Create a member'),
  'user.read': operational('USER', 'READ', 'Read members'),
  'user.update': operational('USER', 'UPDATE', 'Update a member'),
  'user.delete': operational('USER', 'DELETE', 'Remove a member'),
  'user.assign_role': operational('USER', 'ASSIGN', "Change a member's role"),
  'user.invite': operational('USER', 'INVITE', 'Invite a person to the tenant'),

  'tenant.manage': operational(
    'TENANT',
    'MANAGE',
    "Manage the tenant's settings",
  ),

  'report.view': operational('REPORT', 'READ', 'View reports'),
  'report.export': operational('REPORT', 'EXPORT', 'Export reports'),

  'document.upload': operational('DOCUMENT', 'CREATE', 'Upload a document'),
  'document.read': operational(
    'DOCUMENT',
    'READ',
    'Read and download documents',
  ),
  'document.delete': operational('DOCUMENT', 'DELETE', 'Delete a document'),

  'chat.send': operational('CHAT', 'CREATE', 'Send chat messages'),
  'chat.read': operational('CHAT', 'READ', 'Read chat messages'),
  'chat.delete': operational('CHAT', 'DELETE', 'Delete chat messages'),

  'performance.create': operational(
    'PERFORMANCE',
    'CREATE',
    'Record performance data',
  ),
  'performance.read': operational(
    'PERFORMANCE',
    'READ',
    'Read performance data',
  ),
  'performance.update': operational(
    'PERFORMANCE',
    'UPDATE',
    'Update performance data',
  ),
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSION_CATALOG;

/** Every key, in the catalog's order. */
export const PERMISSION_KEYS = Object.keys(
  PERMISSION_CATALOG,
) as readonly PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.hasOwn(PERMISSION_CATALOG, value);
}
