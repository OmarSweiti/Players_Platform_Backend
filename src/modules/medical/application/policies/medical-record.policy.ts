import { ALLOW, definePolicy, deny } from '../../../../common/policy/policy';
import { MEDICAL_STAFF } from './medical-staff';

/** What the medical record policy reads of a record. */
export interface MedicalRecordView {
  readonly isConfidential: boolean;
}

export type MedicalRecordAction = 'update' | 'archive';

/**
 * The legacy medical records (0.6.3): the decisions their use cases made
 * inline, moved here. The module is quarantined behind its flag (0.1.8);
 * who reads which records, and what of them, is `0.6.8`'s — until then any
 * member the route admits reads any record (Z-5), and a player's own record
 * waits for the relationships of `0.6.5`.
 */
export const medicalRecordPolicy = definePolicy<
  MedicalRecordAction,
  MedicalRecordView
>({
  read: () => ALLOW,
  // A confidential record is changed by medical staff only.
  update: (member, record) =>
    !record.isConfidential || MEDICAL_STAFF.has(member.role)
      ? ALLOW
      : deny('CONFIDENTIAL'),
  archive: () => ALLOW,
});
