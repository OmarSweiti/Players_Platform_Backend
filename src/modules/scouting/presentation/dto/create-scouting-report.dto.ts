import { PlayerPosition } from '@prisma/client';
import { z } from 'zod';
import { id, line, prose } from '../../../../common/validation/schemas';

export const Recommendation = z.enum([
  'STRONG_SIGN',
  'SIGN',
  'MONITOR',
  'NOT_SUITABLE',
]);

/** A score from 1 to 10, to one decimal place. */
const score = z.number().min(1).max(10).multipleOf(0.1);

export const CreateScoutingReportDto = z.strictObject({
  playerId: id.optional(), // none for an external prospect
  prospectName: line(255).optional(),
  prospectAge: z.number().int().min(15).max(40).optional(),
  prospectClub: line(255).optional(),
  prospectPosition: z.enum(PlayerPosition).optional(),
  prospectNationality: line(100).optional(),
  recommendation: Recommendation.optional(),
  technicalScore: score.optional(),
  physicalScore: score.optional(),
  tacticalScore: score.optional(),
  mentalScore: score.optional(),
  strengths: prose().optional(),
  weaknesses: prose().optional(),
  personalityNotes: prose().optional(),
  tacticalFit: prose().optional(),
  overallRating: score.optional(),
  potentialRating: score.optional(),
  matchObserved: line(255).optional(),
});
export type CreateScoutingReportDto = z.infer<typeof CreateScoutingReportDto>;
