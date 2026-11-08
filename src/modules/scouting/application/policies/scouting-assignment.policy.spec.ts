import type { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ALLOW, deny } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { scoutingAssignmentPolicy } from './scouting-assignment.policy';

// The legacy scouting assignment policy (0.6.3): the decisions its use cases
// made inline, unchanged.

const DIRECTOR = '00000000-0000-4000-8000-00000000000d';
const SCOUT = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';

/** The context a policy reads: the actor. The tenant transaction refuses an unminted one. */
const as = (userId: string, role: UserRole) =>
  ({
    actor: { kind: 'USER', userId, sessionId: 's', role },
  }) as unknown as AuthorizedTenantContext;

const assignment = { assignedById: DIRECTOR, assignedToId: SCOUT };

describe('the scouting assignment policy', () => {
  it('decides as the legacy use cases did', () => {
    const decide = scoutingAssignmentPolicy.authorize;
    // The director who gave it changes or removes it; another director not.
    for (const action of ['update', 'delete'] as const) {
      expect(
        decide(as(DIRECTOR, 'SPORTING_DIRECTOR'), action, assignment),
      ).toEqual(ALLOW);
      expect(
        decide(as(OTHER, 'SPORTING_DIRECTOR'), action, assignment),
      ).toEqual(deny('UNRELATED'));
    }
    // Its progress: any sporting director, or the scout who works it.
    expect(
      decide(as(OTHER, 'SPORTING_DIRECTOR'), 'setStatus', assignment),
    ).toEqual(ALLOW);
    expect(decide(as(SCOUT, 'SCOUT'), 'setStatus', assignment)).toEqual(ALLOW);
    expect(decide(as(OTHER, 'SCOUT'), 'setStatus', assignment)).toEqual(
      deny('UNRELATED'),
    );
    // No other role, the assignee's own included.
    expect(decide(as(SCOUT, 'COACH'), 'setStatus', assignment)).toEqual(
      deny('ROLE'),
    );
    expect(decide(as(OTHER, 'OWNER'), 'setStatus', assignment)).toEqual(
      deny('ROLE'),
    );
  });
});
