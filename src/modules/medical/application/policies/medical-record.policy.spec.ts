import type { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ALLOW, deny } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { medicalRecordPolicy } from './medical-record.policy';

// The legacy medical record policy (0.6.3): a confidential record is changed
// by medical staff only — no longer by SUPER_ADMIN, which the platform role
// never was in a tenant (I-2). Reads stay as they were until 0.6.8.

/** The context a policy reads: the actor. The tenant transaction refuses an unminted one. */
const as = (role: UserRole) =>
  ({
    actor: {
      kind: 'USER',
      userId: '00000000-0000-4000-8000-00000000000a',
      sessionId: 's',
      role,
    },
  }) as unknown as AuthorizedTenantContext;

const confidential = { isConfidential: true };
const ordinary = { isConfidential: false };

describe('the medical record policy', () => {
  it('a_confidential_record_is_changed_by_medical_staff_only', () => {
    const decide = medicalRecordPolicy.authorize;
    for (const role of ['MEDICAL', 'PHYSIOTHERAPIST'] as const) {
      expect(decide(as(role), 'update', confidential)).toEqual(ALLOW);
    }
    for (const role of [
      'SUPER_ADMIN',
      'OWNER',
      'ADMIN',
      'FITNESS_COACH',
    ] as const) {
      expect(decide(as(role), 'update', confidential)).toEqual(
        deny('CONFIDENTIAL'),
      );
      expect(decide(as(role), 'update', ordinary)).toEqual(ALLOW);
    }
    // Reads and archiving are as the legacy module had them (0.6.8).
    expect(decide(as('PLAYER'), 'read', confidential)).toEqual(ALLOW);
    expect(decide(as('ADMIN'), 'archive', confidential)).toEqual(ALLOW);
  });
});
