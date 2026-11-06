import type { UserRole } from '@prisma/client';

/**
 * How much of the tenant a role may hand on (0.5.10): an owner, the whole of
 * it; an administrator, everything but ownership; every other role, nothing.
 * The levels are this rule's own, written out role by role, and never the
 * order of the role enum (DB-58).
 */
const AUTHORITY: Readonly<Record<UserRole, number>> = {
  OWNER: 2,
  ADMIN: 1,
  SPORTING_DIRECTOR: 0,
  SCOUT: 0,
  COACH: 0,
  ASSISTANT_COACH: 0,
  GOALKEEPER_COACH: 0,
  FITNESS_COACH: 0,
  MEDICAL: 0,
  PHYSIOTHERAPIST: 0,
  LEGAL: 0,
  FINANCE_MANAGER: 0,
  PERFORMANCE_ANALYST: 0,
  VIDEO_ANALYST: 0,
  TRAINING_MANAGER: 0,
  PLAYER: 0,
  GUARDIAN: 0,
  // A platform role: it holds no tenant's authority (security-privacy.md).
  SUPER_ADMIN: 0,
};

/**
 * Whether a member holding `granter` may give `role` to someone else: never
 * a role above their own, never without authority to hand on, and never
 * SUPER_ADMIN, a platform role no tenant member grants.
 */
export function mayGrant(granter: UserRole, role: UserRole): boolean {
  return (
    role !== 'SUPER_ADMIN' &&
    AUTHORITY[granter] > 0 &&
    AUTHORITY[role] <= AUTHORITY[granter]
  );
}
