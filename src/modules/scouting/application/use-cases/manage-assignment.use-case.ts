import { Injectable } from '@nestjs/common';
import {
  AssignmentRepository,
  CreateScoutingAssignmentInput,
  UpdateScoutingAssignmentInput,
} from '../../infrastructure/repositories/assignment.repository';

@Injectable()
export class ManageAssignmentUseCase {
  constructor(private readonly assignmentRepo: AssignmentRepository) {}

  /**
   * Create a new scouting assignment
   */
  async createAssignment(input: CreateScoutingAssignmentInput) {
    // Validate age range
    if (input.minAge && input.maxAge && input.minAge > input.maxAge) {
      throw new Error('Minimum age cannot be greater than maximum age');
    }

    // Validate age bounds
    if (input.minAge && (input.minAge < 15 || input.minAge > 40)) {
      throw new Error('Minimum age must be between 15 and 40');
    }

    if (input.maxAge && (input.maxAge < 15 || input.maxAge > 40)) {
      throw new Error('Maximum age must be between 15 and 40');
    }

    // Validate due date
    if (input.dueDate && input.dueDate < new Date()) {
      throw new Error('Due date cannot be in the past');
    }

    return await this.assignmentRepo.create(input);
  }

  /**
   * Update assignment details
   */
  async updateAssignment(
    id: string,
    tenantId: string,
    input: UpdateScoutingAssignmentInput,
    directorId: string,
  ) {
    const assignment = await this.assignmentRepo.findById(id, tenantId);

    if (!assignment) {
      throw new Error('Assignment not found');
    }

    // Only the creator (sporting director) can update
    if (assignment.assignedById !== directorId) {
      throw new Error('Only the assigning director can update this assignment');
    }

    // Validate age range if updating
    if (input.minAge && input.maxAge && input.minAge > input.maxAge) {
      throw new Error('Minimum age cannot be greater than maximum age');
    }

    return await this.assignmentRepo.update(id, tenantId, input);
  }

  /**
   * Update assignment status
   */
  async updateStatus(
    id: string,
    tenantId: string,
    status: string,
    userId: string,
    userRole: string,
  ) {
    const assignment = await this.assignmentRepo.findById(id, tenantId);

    if (!assignment) {
      throw new Error('Assignment not found');
    }

    // Validate status transition
    const validStatuses = ['OPEN', 'IN_PROGRESS', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      throw new Error(
        'Invalid status. Must be OPEN, IN_PROGRESS, or COMPLETED',
      );
    }

    // Scout can only update their own assignments to IN_PROGRESS or COMPLETED
    if (userRole === 'SCOUT' && assignment.assignedToId !== userId) {
      throw new Error('You can only update your own assignments');
    }

    // Sporting Director can update any assignment
    if (userRole !== 'SPORTING_DIRECTOR' && userRole !== 'SCOUT') {
      throw new Error('Insufficient permissions to update assignment status');
    }

    return await this.assignmentRepo.updateStatus(id, tenantId, status);
  }

  /**
   * Get assignments for a scout
   */
  async getAssignmentsByScout(
    scoutId: string,
    tenantId: string,
    status?: string,
  ) {
    return await this.assignmentRepo.getAssignmentsByScout(
      scoutId,
      tenantId,
      status,
    );
  }

  /**
   * Get assignments created by a director
   */
  async getAssignmentsByDirector(
    directorId: string,
    tenantId: string,
    status?: string,
  ) {
    return await this.assignmentRepo.getAssignmentsByDirector(
      directorId,
      tenantId,
      status,
    );
  }

  /**
   * Get open assignments count for a scout
   */
  async getOpenAssignmentsCount(scoutId: string, tenantId: string) {
    return await this.assignmentRepo.getOpenAssignmentsCount(scoutId, tenantId);
  }

  /**
   * Delete assignment
   */
  async deleteAssignment(id: string, tenantId: string, directorId: string) {
    const assignment = await this.assignmentRepo.findById(id, tenantId);

    if (!assignment) {
      throw new Error('Assignment not found');
    }

    // Only the creator can delete
    if (assignment.assignedById !== directorId) {
      throw new Error('Only the assigning director can delete this assignment');
    }

    return await this.assignmentRepo.delete(id, tenantId);
  }
}
