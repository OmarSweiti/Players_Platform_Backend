import { UserRole } from '@prisma/client';

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  SUPER_ADMIN: 100,
  OWNER: 90,
  ADMIN: 80,
  SPORTING_DIRECTOR: 70,
  LEGAL: 65,
  FINANCE_MANAGER: 60,
  COACH: 55,
  PERFORMANCE_ANALYST: 50,
  VIDEO_ANALYST: 48,
  TRAINING_MANAGER: 45,
  ASSISTANT_COACH: 40,
  GOALKEEPER_COACH: 40,
  FITNESS_COACH: 40,
  MEDICAL: 50,
  PHYSIOTHERAPIST: 45,
  SCOUT: 45,
  PLAYER: 10,
  GUARDIAN: 15,
};

export const ROLE_DISPLAY_NAMES: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super Administrator',
  OWNER: 'Club Owner',
  ADMIN: 'Administrator',
  SPORTING_DIRECTOR: 'Sporting Director',
  SCOUT: 'Scout',
  COACH: 'Head Coach',
  ASSISTANT_COACH: 'Assistant Coach',
  GOALKEEPER_COACH: 'Goalkeeper Coach',
  FITNESS_COACH: 'Fitness Coach',
  MEDICAL: 'Medical Staff',
  PHYSIOTHERAPIST: 'Physiotherapist',
  LEGAL: 'Legal Counsel',
  FINANCE_MANAGER: 'Finance Manager',
  PERFORMANCE_ANALYST: 'Performance Analyst',
  VIDEO_ANALYST: 'Video Analyst',
  TRAINING_MANAGER: 'Training Manager',
  PLAYER: 'Player',
  GUARDIAN: 'Guardian',
};

export type RoleCategory = 'executive' | 'operations' | 'football' | 'medical' | 'legal' | 'finance' | 'analysis' | 'player' | 'guardian';

export const ROLE_CATEGORIES: Record<UserRole, RoleCategory> = {
  SUPER_ADMIN: 'executive',
  OWNER: 'executive',
  ADMIN: 'operations',
  SPORTING_DIRECTOR: 'football',
  SCOUT: 'football',
  COACH: 'football',
  ASSISTANT_COACH: 'football',
  GOALKEEPER_COACH: 'football',
  FITNESS_COACH: 'football',
  MEDICAL: 'medical',
  PHYSIOTHERAPIST: 'medical',
  LEGAL: 'legal',
  FINANCE_MANAGER: 'finance',
  PERFORMANCE_ANALYST: 'analysis',
  VIDEO_ANALYST: 'analysis',
  TRAINING_MANAGER: 'operations',
  PLAYER: 'player',
  GUARDIAN: 'guardian',
};

/**
 * Get display name for a role
 */
export function getRoleDisplayName(role: UserRole): string {
  return ROLE_DISPLAY_NAMES[role] || role;
}

/**
 * Check if user has higher or equal hierarchy level
 */
export function hasHigherOrEqualHierarchy(userRole: UserRole, targetRole: UserRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[targetRole];
}

/**
 * Get all roles in a category
 */
export function getRolesByCategory(category: RoleCategory): UserRole[] {
  return Object.entries(ROLE_CATEGORIES)
    .filter(([_, cat]) => cat === category)
    .map(([role]) => role as UserRole);
}
