import { z } from 'zod';
import { nonEmpty } from '../../../../common/validation/schemas';
import { CreateAssignmentDto } from './create-assignment.dto';

export const AssignmentStatus = z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED']);

export const UpdateAssignmentDto = nonEmpty(
  CreateAssignmentDto.extend({ status: AssignmentStatus }).partial(),
);
export type UpdateAssignmentDto = z.infer<typeof UpdateAssignmentDto>;

export const AssignmentStatusDto = z.strictObject({ status: AssignmentStatus });
export type AssignmentStatusDto = z.infer<typeof AssignmentStatusDto>;

export const AssignmentsQuery = z.strictObject({
  status: AssignmentStatus.optional(),
});
export type AssignmentsQuery = z.infer<typeof AssignmentsQuery>;
