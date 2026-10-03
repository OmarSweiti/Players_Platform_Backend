import { z } from 'zod';
import { nonEmpty } from '../../../../common/validation/schemas';
import {
  CreateScoutingReportDto,
  Recommendation,
} from './create-scouting-report.dto';

export const ScoutingReportStatus = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
]);

export const UpdateScoutingReportDto = nonEmpty(
  CreateScoutingReportDto.extend({ status: ScoutingReportStatus }).partial(),
);
export type UpdateScoutingReportDto = z.infer<typeof UpdateScoutingReportDto>;

// Approval records the final recommendation, so it is required.
export const ApproveScoutingReportDto = z.strictObject({
  recommendation: Recommendation,
});
export type ApproveScoutingReportDto = z.infer<typeof ApproveScoutingReportDto>;
