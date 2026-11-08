import type { ScoutReportStatus, UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ALLOW, deny } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { scoutingReportPolicy } from './scouting-report.policy';

// The legacy scouting report policy (0.6.3): the decisions its use cases
// made inline, unchanged — including the defects the rebuild closes (1.11).

const AUTHOR = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';

/** The context a policy reads: the actor. The tenant transaction refuses an unminted one. */
const as = (userId: string, role: UserRole = 'SCOUT') =>
  ({
    actor: { kind: 'USER', userId, sessionId: 's', role },
  }) as unknown as AuthorizedTenantContext;

const report = (status: ScoutReportStatus) => ({ scoutId: AUTHOR, status });

describe('the scouting report policy', () => {
  it('decides as the legacy use cases did', () => {
    const decide = scoutingReportPolicy.authorize;
    // Anyone the route admits reads any report.
    expect(decide(as(OTHER, 'COACH'), 'read', report('APPROVED'))).toEqual(
      ALLOW,
    );
    // A draft is editable by anyone (Z-7, 1.11.3); past it, not by its author
    // (the state) nor by anyone else (unrelated).
    expect(decide(as(OTHER), 'update', report('DRAFT'))).toEqual(ALLOW);
    expect(decide(as(AUTHOR), 'update', report('SUBMITTED'))).toEqual(
      deny('STATE'),
    );
    expect(decide(as(OTHER), 'update', report('SUBMITTED'))).toEqual(
      deny('UNRELATED'),
    );
    // Only the author submits, and only a draft.
    expect(decide(as(AUTHOR), 'submit', report('DRAFT'))).toEqual(ALLOW);
    expect(decide(as(OTHER), 'submit', report('DRAFT'))).toEqual(
      deny('UNRELATED'),
    );
    expect(decide(as(AUTHOR), 'submit', report('APPROVED'))).toEqual(
      deny('STATE'),
    );
    // A submitted report is decided, and nothing else is.
    for (const action of ['approve', 'reject'] as const) {
      expect(decide(as(OTHER), action, report('SUBMITTED'))).toEqual(ALLOW);
      expect(decide(as(OTHER), action, report('DRAFT'))).toEqual(deny('STATE'));
    }
    expect(decide(as(OTHER), 'archive', report('APPROVED'))).toEqual(ALLOW);
  });
});
