import type { z } from 'zod';
import { nonEmpty } from '../../../../common/validation/schemas';
import { CreateMedicalRecordDto } from './create-medical-record.dto';

export const UpdateMedicalRecordDto = nonEmpty(
  CreateMedicalRecordDto.partial(),
);
export type UpdateMedicalRecordDto = z.infer<typeof UpdateMedicalRecordDto>;
