import { ALLOW, definePolicy, deny } from '../../../../common/policy/policy';

/** What the scouting assignment policy reads of an assignment. */
export interface ScoutingAssignmentView {
  /** The director who gave it. */
  readonly assignedById: string;
  /** The scout who works it. */
  readonly assignedToId: string;
}

export type ScoutingAssignmentAction = 'update' | 'setStatus' | 'delete';

/**
 * The legacy scouting assignments (0.6.3): the decisions their use cases
 * made inline, moved here unchanged; the module is rebuilt by `1.11`. The
 * director who gave an assignment changes or removes it; its progress is
 * moved on by a sporting director, or by the scout who works it.
 */
export const scoutingAssignmentPolicy = definePolicy<
  ScoutingAssignmentAction,
  ScoutingAssignmentView
>({
  read: () => ALLOW,
  update: (member, assignment) =>
    assignment.assignedById === member.userId ? ALLOW : deny('UNRELATED'),
  delete: (member, assignment) =>
    assignment.assignedById === member.userId ? ALLOW : deny('UNRELATED'),
  setStatus: (member, assignment) => {
    switch (member.role) {
      case 'SPORTING_DIRECTOR':
        return ALLOW;
      case 'SCOUT':
        return assignment.assignedToId === member.userId
          ? ALLOW
          : deny('UNRELATED');
      default:
        return deny('ROLE');
    }
  },
});
