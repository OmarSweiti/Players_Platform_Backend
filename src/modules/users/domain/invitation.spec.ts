import { describe, expect, it } from 'vitest';
import { INVITATION_LIFETIME_MS, statusOf } from './invitation';

// What became of an invitation (0.5.10), read at an instant.

const at = new Date('2026-11-06T12:00:00.000Z');
const open = { acceptedAt: null, revokedAt: null };

describe('an invitation status', () => {
  it('an_invitation_lasts_seven_days', () => {
    expect(INVITATION_LIFETIME_MS).toBe(7 * 24 * 3_600_000);
  });

  it('an_open_invitation_is_pending_until_its_expiry_and_expired_from_it', () => {
    const before = new Date(at.getTime() + 1);
    expect(statusOf({ ...open, expiresAt: before }, at)).toBe('pending');
    expect(statusOf({ ...open, expiresAt: at }, at)).toBe('expired');
  });

  it('a_closed_invitation_stays_closed_whatever_its_expiry', () => {
    const past = new Date(at.getTime() - 1);
    expect(statusOf({ ...open, acceptedAt: past, expiresAt: past }, at)).toBe(
      'accepted',
    );
    expect(statusOf({ ...open, revokedAt: past, expiresAt: past }, at)).toBe(
      'revoked',
    );
  });
});
