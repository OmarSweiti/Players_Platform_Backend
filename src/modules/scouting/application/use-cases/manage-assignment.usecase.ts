import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import {
  Assignments,
  type CreateScoutingAssignmentInput,
  type UpdateScoutingAssignmentInput,
} from '../ports/assignments.port';

/**
 * Scouting assignments in the context's tenant (0.4.12): the acting member
 * gives them, as the director, or works them, as the scout. `memberRole` is
 * the signed-in member's, from the session.
 */
@Injectable()
export class ManageAssignmentUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly assignmentRepo: Assignments,
  ) {}

  /**
   * Create a new scouting assignment, given by the acting member
   */
  async createAssignment(
    ctx: AuthorizedTenantContext,
    input: Omit<CreateScoutingAssignmentInput, 'assignedById'>,
  ) {
    // Validate age range
    if (input.minAge && input.maxAge && input.minAge > input.maxAge) {
      throw new ValidationFailedError(
        'Minimum age cannot be greater than maximum age',
        [{ field: '/minAge', code: 'OUT_OF_RANGE' }],
      );
    }

    // Validate age bounds
    if (input.minAge && (input.minAge < 15 || input.minAge > 40)) {
      throw new ValidationFailedError('Minimum age must be between 15 and 40', [
        { field: '/minAge', code: 'OUT_OF_RANGE' },
      ]);
    }

    if (input.maxAge && (input.maxAge < 15 || input.maxAge > 40)) {
      throw new ValidationFailedError('Maximum age must be between 15 and 40', [
        { field: '/maxAge', code: 'OUT_OF_RANGE' },
      ]);
    }

    // Validate due date
    if (input.dueDate && input.dueDate < new Date()) {
      throw new ValidationFailedError('Due date cannot be in the past', [
        { field: '/dueDate', code: 'OUT_OF_RANGE' },
      ]);
    }

    const assignedById = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.assignmentRepo.create(tx, ctx, { ...input, assignedById }),
    );
  }

  /**
   * Update assignment details
   */
  async updateAssignment(
    ctx: AuthorizedTenantContext,
    id: string,
    input: UpdateScoutingAssignmentInput,
  ) {
    // Validate age range if updating
    if (input.minAge && input.maxAge && input.minAge > input.maxAge) {
      throw new ValidationFailedError(
        'Minimum age cannot be greater than maximum age',
        [{ field: '/minAge', code: 'OUT_OF_RANGE' }],
      );
    }

    const directorId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const assignment = await this.assignmentRepo.findById(tx, ctx, id);
      if (!assignment) {
        throw new NotFoundError('Assignment not found');
      }

      // Only the creator (sporting director) can update
      if (assignment.assignedById !== directorId) {
        throw new ForbiddenError(
          'Only the assigning director can update this assignment',
        );
      }

      return this.assignmentRepo.update(tx, ctx, id, input);
    });
  }

  /**
   * Update assignment status
   */
  async updateStatus(
    ctx: AuthorizedTenantContext,
    id: string,
    status: string,
    memberRole: string,
  ) {
    // Validate status transition
    const validStatuses = ['OPEN', 'IN_PROGRESS', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      throw new ValidationFailedError(
        'Invalid status. Must be OPEN, IN_PROGRESS, or COMPLETED',
        [{ field: '/status', code: 'INVALID_VALUE' }],
      );
    }

    const memberId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const assignment = await this.assignmentRepo.findById(tx, ctx, id);
      if (!assignment) {
        throw new NotFoundError('Assignment not found');
      }

      // Scout can only update their own assignments to IN_PROGRESS or COMPLETED
      if (memberRole === 'SCOUT' && assignment.assignedToId !== memberId) {
        throw new ForbiddenError('You can only update your own assignments');
      }

      // Sporting Director can update any assignment
      if (memberRole !== 'SPORTING_DIRECTOR' && memberRole !== 'SCOUT') {
        throw new ForbiddenError(
          'Insufficient permissions to update assignment status',
        );
      }

      return this.assignmentRepo.updateStatus(tx, ctx, id, status);
    });
  }

  /**
   * The assignments given to the acting member, as a scout
   */
  async getAssignmentsByScout(ctx: AuthorizedTenantContext, status?: string) {
    const scoutId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.assignmentRepo.getAssignmentsByScout(tx, ctx, scoutId, status),
    );
  }

  /**
   * The assignments the acting member gave, as a director
   */
  async getAssignmentsByDirector(
    ctx: AuthorizedTenantContext,
    status?: string,
  ) {
    const directorId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.assignmentRepo.getAssignmentsByDirector(tx, ctx, directorId, status),
    );
  }

  /**
   * Delete assignment
   */
  async deleteAssignment(ctx: AuthorizedTenantContext, id: string) {
    const directorId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const assignment = await this.assignmentRepo.findById(tx, ctx, id);
      if (!assignment) {
        throw new NotFoundError('Assignment not found');
      }

      // Only the creator can delete
      if (assignment.assignedById !== directorId) {
        throw new ForbiddenError(
          'Only the assigning director can delete this assignment',
        );
      }

      return this.assignmentRepo.delete(tx, ctx, id);
    });
  }
}
