import { z } from 'zod';
import {
  id,
  instant,
  line,
  prose,
} from '../../../../common/validation/schemas';

export const TreatmentSessionStatus = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

export const CreateTreatmentSessionDto = z.strictObject({
  playerId: id,
  medicalRecordId: id.optional(),
  sessionDate: instant,
  duration: z.number().int().min(15).max(480).optional(), // minutes
  status: TreatmentSessionStatus.optional(),
  treatmentType: line(100),
  description: prose().optional(),
  exercises: prose().optional(),
  progressNotes: prose().optional(),
});
export type CreateTreatmentSessionDto = z.infer<
  typeof CreateTreatmentSessionDto
>;
