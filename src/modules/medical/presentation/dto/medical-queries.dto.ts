import { z } from 'zod';
import {
  dayOrInstant,
  flag,
  id,
  line,
  paging,
} from '../../../../common/validation/schemas';
import { TreatmentSessionStatus } from './create-treatment-session.dto';

export const PlayerMedicalRecordsQuery = z.strictObject({
  ...paging,
  injuryType: line(255).optional(),
  isConfidential: flag.optional(),
});
export type PlayerMedicalRecordsQuery = z.infer<
  typeof PlayerMedicalRecordsQuery
>;

export const MedicalRecordsQuery = PlayerMedicalRecordsQuery.extend({
  playerId: id.optional(),
});
export type MedicalRecordsQuery = z.infer<typeof MedicalRecordsQuery>;

export const PlayerTreatmentSessionsQuery = z.strictObject({
  ...paging,
  status: TreatmentSessionStatus.optional(),
  medicalRecordId: id.optional(),
  dateFrom: dayOrInstant.optional(),
  dateTo: dayOrInstant.optional(),
});
export type PlayerTreatmentSessionsQuery = z.infer<
  typeof PlayerTreatmentSessionsQuery
>;
