/** How long an invitation stays open: seven days from when it is made (0.5.10). */
export const INVITATION_DAYS = 7;

export const INVITATION_LIFETIME_MS = INVITATION_DAYS * 24 * 60 * 60 * 1000;

/** What became of an invitation, as the list shows it. */
export const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'expired',
  'revoked',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** The moments an invitation's status is read from. */
export interface InvitationTimes {
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Its status at `at`: closed for good once accepted or revoked; otherwise
 * pending until it expires, at its expiry and after.
 */
export function statusOf(
  invitation: InvitationTimes,
  at: Date,
): InvitationStatus {
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.revokedAt !== null) return 'revoked';
  return invitation.expiresAt > at ? 'pending' : 'expired';
}
