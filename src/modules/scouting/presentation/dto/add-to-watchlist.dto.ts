import { z } from 'zod';
import { id, prose } from '../../../../common/validation/schemas';

export const AddToWatchlistDto = z.strictObject({
  playerId: id,
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  notes: prose().optional(),
});
export type AddToWatchlistDto = z.infer<typeof AddToWatchlistDto>;
