import type { ScoutReportStatus } from '@prisma/client';
import { ALLOW, definePolicy, deny } from '../../../../common/policy/policy';

/** What the scouting report policy reads of a report. */
export interface ScoutingReportView {
  /** Its author. */
  readonly scoutId: string;
  readonly status: ScoutReportStatus;
}

export type ScoutingReportAction =
  'update' | 'submit' | 'approve' | 'reject' | 'archive';

/**
 * The legacy scouting reports (0.6.3): the decisions their use cases made
 * inline, moved here unchanged. The module is quarantined behind its flag
 * (0.1.8) and rebuilt by `1.11`; its known defects stay until then rather
 * than being half-fixed here — any member the route admits reads any report,
 * anyone may edit a draft (Z-7, `1.11.3`), and an approver may decide their
 * own report (`1.11`).
 */
export const scoutingReportPolicy = definePolicy<
  ScoutingReportAction,
  ScoutingReportView
>({
  read: () => ALLOW,
  // A draft only; past it, someone else's report is not theirs to touch, and
  // their own is no longer editable.
  update: (member, report) =>
    report.status === 'DRAFT'
      ? ALLOW
      : deny(report.scoutId === member.userId ? 'STATE' : 'UNRELATED'),
  // The author's own draft.
  submit: (member, report) =>
    report.scoutId !== member.userId
      ? deny('UNRELATED')
      : report.status === 'DRAFT'
        ? ALLOW
        : deny('STATE'),
  approve: (_, report) =>
    report.status === 'SUBMITTED' ? ALLOW : deny('STATE'),
  reject: (_, report) =>
    report.status === 'SUBMITTED' ? ALLOW : deny('STATE'),
  archive: () => ALLOW,
});
