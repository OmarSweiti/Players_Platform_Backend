import { describe, expect, it } from 'vitest';
import { ALLOW, deny } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { invitationPolicy } from './invitation.policy';

// The invitation policy (0.6.3): an open invitation is revoked, a revoked one
// stays revoked without a refusal, and an accepted one stays accepted.

/** The context a policy reads: the actor. The tenant transaction refuses an unminted one. */
const admin = {
  actor: {
    kind: 'USER',
    userId: '00000000-0000-4000-8000-00000000000a',
    sessionId: 's',
    role: 'ADMIN',
  },
} as unknown as AuthorizedTenantContext;

const at = new Date('2026-11-08T10:00:00Z');

describe('the invitation policy', () => {
  it('an_accepted_invitation_cannot_be_revoked', () => {
    const decide = invitationPolicy.authorize;
    const open = { acceptedAt: null, revokedAt: null };
    expect(decide(admin, 'read', open)).toEqual(ALLOW);
    expect(decide(admin, 'revoke', open)).toEqual(ALLOW);
    expect(
      decide(admin, 'revoke', { acceptedAt: null, revokedAt: at }),
    ).toEqual(ALLOW);
    expect(
      decide(admin, 'revoke', { acceptedAt: at, revokedAt: null }),
    ).toEqual(deny('STATE'));
  });
});
