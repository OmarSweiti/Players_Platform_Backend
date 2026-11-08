import type { TreatmentStatus } from '@prisma/client';
import { ALLOW, definePolicy, deny } from '../../../../common/policy/policy';
import { MEDICAL_STAFF } from './medical-staff';

/** What the treatment session policy reads of a session. */
export interface TreatmentSessionView {
  /** The member who conducts it. */
  readonly conductedBy: string;
  readonly status: TreatmentStatus;
}

export type TreatmentSessionAction = 'update' | 'setStatus' | 'delete';

/**
 * The legacy treatment sessions (0.6.3): the decisions their use cases made
 * inline, moved here unchanged. A session is edited by its conductor or by
 * medical staff, until it is completed. Its status and its removal were never
 * checked beyond the route's permission, and are not here; sessions stop
 * being hard-deleted in `0.6.8`.
 */
export const treatmentSessionPolicy = definePolicy<
  TreatmentSessionAction,
  TreatmentSessionView
>({
  read: () => ALLOW,
  update: (member, session) =>
    session.conductedBy !== member.userId && !MEDICAL_STAFF.has(member.role)
      ? deny('UNRELATED')
      : session.status === 'COMPLETED'
        ? deny('STATE')
        : ALLOW,
  setStatus: () => ALLOW,
  delete: () => ALLOW,
});
