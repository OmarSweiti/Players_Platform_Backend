import { describe, expect, it } from 'vitest';
import { ALLOW, deny } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { membershipPolicy } from './membership.policy';

// The membership policy (0.6.3): only an archived membership comes back.

/** The context a policy reads: the actor. The tenant transaction refuses an unminted one. */
const admin = {
  actor: {
    kind: 'USER',
    userId: '00000000-0000-4000-8000-00000000000a',
    sessionId: 's',
    role: 'ADMIN',
  },
} as unknown as AuthorizedTenantContext;

describe('the membership policy', () => {
  it('only_an_archived_membership_is_reactivated', () => {
    const decide = membershipPolicy.authorize;
    expect(
      decide(admin, 'reactivate', { deletedAt: new Date('2026-11-01') }),
    ).toEqual(ALLOW);
    expect(decide(admin, 'reactivate', { deletedAt: null })).toEqual(
      deny('STATE'),
    );
  });
});
