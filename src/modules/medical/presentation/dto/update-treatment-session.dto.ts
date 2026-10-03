import { z } from 'zod';
import { nonEmpty } from '../../../../common/validation/schemas';
import {
  CreateTreatmentSessionDto,
  TreatmentSessionStatus,
} from './create-treatment-session.dto';

export const UpdateTreatmentSessionDto = nonEmpty(
  CreateTreatmentSessionDto.partial(),
);
export type UpdateTreatmentSessionDto = z.infer<
  typeof UpdateTreatmentSessionDto
>;

export const TreatmentSessionStatusDto = z.strictObject({
  status: TreatmentSessionStatus,
});
export type TreatmentSessionStatusDto = z.infer<
  typeof TreatmentSessionStatusDto
>;
