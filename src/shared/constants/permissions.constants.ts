export const PERMISSIONS = {
  // Player Management
  PLAYER_CREATE: 'player.create',
  PLAYER_READ: 'player.read',
  PLAYER_UPDATE: 'player.update',
  PLAYER_DELETE: 'player.delete',
  PLAYER_EXPORT: 'player.export',

  // Contract Management
  CONTRACT_CREATE: 'contract.create',
  CONTRACT_READ: 'contract.read',
  CONTRACT_UPDATE: 'contract.update',
  CONTRACT_DELETE: 'contract.delete',
  CONTRACT_APPROVE: 'contract.approve',
  CONTRACT_REJECT: 'contract.reject',

  // Training
  TRAINING_CREATE: 'training.create',
  TRAINING_READ: 'training.read',
  TRAINING_UPDATE: 'training.update',
  TRAINING_DELETE: 'training.delete',
  TRAINING_ASSIGN: 'training.assign',

  // Medical (confidential)
  MEDICAL_CREATE: 'medical.create',
  MEDICAL_READ: 'medical.read',
  MEDICAL_UPDATE: 'medical.update',
  MEDICAL_VIEW_CONFIDENTIAL: 'medical.view_confidential',

  // Scouting
  SCOUTING_CREATE: 'scouting.create',
  SCOUTING_READ: 'scouting.read',
  SCOUTING_UPDATE: 'scouting.update',
  SCOUTING_DELETE: 'scouting.delete',

  // Scouting Reports (granular)
  SREPORT_CREATE: 'scouting.report.create',
  SREPORT_READ: 'scouting.report.read',
  SREPORT_UPDATE: 'scouting.report.update',
  SREPORT_DELETE: 'scouting.report.delete',
  SREPORT_SUBMIT: 'scouting.report.submit',
  SREPORT_APPROVE: 'scouting.report.approve',
  SREPORT_REJECT: 'scouting.report.reject',

  // Watchlist
  WATCHLIST_VIEW: 'scouting.watchlist.view',
  WATCHLIST_MANAGE: 'scouting.watchlist.manage',

  // Assignments
  ASSIGNMENT_VIEW: 'scouting.assignment.view',
  ASSIGNMENT_MANAGE: 'scouting.assignment.manage',
  ASSIGNMENT_UPDATE: 'scouting.assignment.update',

  // Match Management
  MATCH_CREATE: 'match.create',
  MATCH_READ: 'match.read',
  MATCH_UPDATE: 'match.update',
  MATCH_DELETE: 'match.delete',

  // Finance
  FINANCE_READ: 'finance.read',
  FINANCE_MANAGE: 'finance.manage',
  FINANCE_EXPORT: 'finance.export',

  // Legal
  LEGAL_CREATE: 'legal.create',
  LEGAL_READ: 'legal.read',
  LEGAL_UPDATE: 'legal.update',
  LEGAL_APPROVE: 'legal.approve',

  // User Management
  USER_CREATE: 'user.create',
  USER_READ: 'user.read',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  USER_ASSIGN_ROLE: 'user.assign_role',

  // Tenant Management
  TENANT_MANAGE: 'tenant.manage',

  // Reports & Analytics
  REPORT_VIEW: 'report.view',
  REPORT_EXPORT: 'report.export',

  // Documents
  DOCUMENT_UPLOAD: 'document.upload',
  DOCUMENT_DELETE: 'document.delete',

  // Chat
  CHAT_SEND: 'chat.send',
  CHAT_READ: 'chat.read',
  CHAT_DELETE: 'chat.delete',

  // Performance
  PERFORMANCE_CREATE: 'performance.create',
  PERFORMANCE_READ: 'performance.read',
  PERFORMANCE_UPDATE: 'performance.update',
} as const;

export type PermissionType = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
