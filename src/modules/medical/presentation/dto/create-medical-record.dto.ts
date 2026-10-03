import { z } from 'zod';
import { day, id, line, prose } from '../../../../common/validation/schemas';

export const CreateMedicalRecordDto = z.strictObject({
  playerId: id,
  injuryType: line(255),
  bodyPart: line(100).optional(),
  severity: line(50).optional(),
  description: prose().optional(),
  treatment: prose().optional(),
  injuryDate: day.optional(),
  recoveryDate: day.optional(),
  returnToPlayDate: day.optional(),
  isConfidential: z.boolean().optional(),
});
export type CreateMedicalRecordDto = z.infer<typeof CreateMedicalRecordDto>;
