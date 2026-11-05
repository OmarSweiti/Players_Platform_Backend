import { Inject, Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { CLOCK, type Clock } from '../../../common/time/clock';

/**
 * The roles that hold no session without a second factor (0.5.8; SR-AUTH-002):
 * the plan's owner, admin, legal, finance, medical, physiotherapist and
 * sporting director, and the platform's super admin besides. Tenants choose
 * their own from `1.1.2`; until then these are everyone's.
 */
export const PRIVILEGED_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'SUPER_ADMIN',
  'OWNER',
  'ADMIN',
  'LEGAL',
  'FINANCE_MANAGER',
  'MEDICAL',
  'PHYSIOTHERAPIST',
  'SPORTING_DIRECTOR',
]);

/**
 * The level of assurance a second factor gives: the realm asserts it as the
 * `acr` "2" (OTP or WebAuthn, 0.5.1); a password alone is "1".
 */
export const SECOND_FACTOR_LEVEL = '2';

/** How recent an authentication a sensitive action needs: five minutes. */
export const RECENT_AUTHENTICATION_MS = 5 * 60 * 1000;

/** Whether `role` needs a second factor to hold a session. */
export function needsSecondFactor(role: UserRole): boolean {
  return PRIVILEGED_ROLES.has(role);
}

/** Whether the provider asserted a second factor: a level of 2 or more. */
export function assertsSecondFactor(acr: string | null | undefined): boolean {
  return (
    typeof acr === 'string' &&
    /^\d{1,2}$/.test(acr) &&
    Number(acr) >= Number(SECOND_FACTOR_LEVEL)
  );
}

/** Whether a member of `role` may hold a session at the assurance `acr`. */
export function admits(
  role: UserRole,
  acr: string | null | undefined,
): boolean {
  return !needsSecondFactor(role) || assertsSecondFactor(acr);
}

/**
 * How recent an authentication is, against the injected clock (0.5.8):
 * sensitive actions (`@RequiresRecentAuth()`) need one within five minutes.
 */
@Injectable()
export class AssurancePolicy {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  isRecent(authTime: Date): boolean {
    return (
      this.clock.now().getTime() - authTime.getTime() <=
      RECENT_AUTHENTICATION_MS
    );
  }
}
