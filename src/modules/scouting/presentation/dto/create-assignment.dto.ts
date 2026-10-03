import { PlayerPosition } from '@prisma/client';
import { z } from 'zod';
import { day, id, line, prose } from '../../../../common/validation/schemas';

const age = z.number().int().min(15).max(40);

export const CreateAssignmentDto = z.strictObject({
  assignedToId: id,
  region: line(100).optional(),
  competition: line(150).optional(),
  targetPosition: z.enum(PlayerPosition).optional(),
  minAge: age.optional(),
  maxAge: age.optional(),
  dueDate: day.optional(),
  notes: prose().optional(),
});
export type CreateAssignmentDto = z.infer<typeof CreateAssignmentDto>;
