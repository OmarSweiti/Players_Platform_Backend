import { z } from 'zod';
import {
  dayOrInstant,
  id,
  paging,
} from '../../../../common/validation/schemas';
import { Recommendation } from './create-scouting-report.dto';
import { ScoutingReportStatus } from './update-scouting-report.dto';

export const QueryScoutingReportsDto = z.strictObject({
  ...paging,
  status: ScoutingReportStatus.optional(),
  scoutId: id.optional(),
  playerId: id.optional(),
  recommendation: Recommendation.optional(),
  dateFrom: dayOrInstant.optional(),
  dateTo: dayOrInstant.optional(),
});
export type QueryScoutingReportsDto = z.infer<typeof QueryScoutingReportsDto>;
