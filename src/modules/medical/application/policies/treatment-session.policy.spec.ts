import type { TreatmentStatus, UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ALLOW, deny } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { treatmentSessionPolicy } from './treatment-session.policy';

// The legacy treatment session policy (0.6.3): a session is edited by its
// conductor or by medical staff, until it is completed.

const CONDUCTOR = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';

/** The context a policy reads: the actor. The tenant transaction refuses an unminted one. */
const as = (userId: string, role: UserRole) =>
  ({
    actor: { kind: 'USER', userId, sessionId: 's', role },
  }) as unknown as AuthorizedTenantContext;

const session = (status: TreatmentStatus) => ({
  conductedBy: CONDUCTOR,
  status,
});

describe('the treatment session policy', () => {
  it('decides as the legacy use cases did', () => {
    const decide = treatmentSessionPolicy.authorize;
    expect(
      decide(as(CONDUCTOR, 'FITNESS_COACH'), 'update', session('SCHEDULED')),
    ).toEqual(ALLOW);
    expect(
      decide(as(OTHER, 'PHYSIOTHERAPIST'), 'update', session('SCHEDULED')),
    ).toEqual(ALLOW);
    expect(
      decide(as(OTHER, 'SUPER_ADMIN'), 'update', session('SCHEDULED')),
    ).toEqual(deny('UNRELATED'));
    expect(decide(as(OTHER, 'COACH'), 'update', session('SCHEDULED'))).toEqual(
      deny('UNRELATED'),
    );
    // A completed session is not edited, by its conductor either.
    expect(
      decide(as(CONDUCTOR, 'MEDICAL'), 'update', session('COMPLETED')),
    ).toEqual(deny('STATE'));
    // Status and removal: never checked beyond the route's permission.
    expect(
      decide(as(OTHER, 'COACH'), 'setStatus', session('COMPLETED')),
    ).toEqual(ALLOW);
    expect(decide(as(OTHER, 'COACH'), 'delete', session('COMPLETED'))).toEqual(
      ALLOW,
    );
  });
});
