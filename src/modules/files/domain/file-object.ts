import { CONFIDENTIAL_CLASSES } from '../../../common/policy/confidential-class';

/**
 * Where a file is in its life (0.8.2; domain-workflows.md, "Files"): made,
 * its upload under way, its exact bytes pinned, being scanned, derived —
 * unused until 1.3.3 — and READY; or one of three ends.
 */
export const FILE_STATUSES = [
  'CREATED',
  'UPLOADING',
  'UPLOADED',
  'SCANNING',
  'PROCESSING',
  'READY',
  'FAILED',
  'REJECTED',
  'ABORTED',
] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** What the malware scan said of a file's exact bytes (0.8.4). */
export const SCAN_VERDICTS = ['PENDING', 'CLEAN', 'INFECTED', 'ERROR'] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

/**
 * How confidential a file is: operational, or one of the confidential
 * classes, which no member receives by default (SR-ACL-008).
 */
export const FILE_CLASSIFICATIONS = [
  'OPERATIONAL',
  ...CONFIDENTIAL_CLASSES,
] as const;
export type FileClassification = (typeof FILE_CLASSIFICATIONS)[number];

/**
 * The moves a file may make, and no others. A file is pinned before it is
 * scanned, scanned before it is READY, and an end is an end. SCANNING goes
 * straight to READY until derivatives exist (PROCESSING, 1.3.3).
 */
const NEXT: Readonly<Record<FileStatus, readonly FileStatus[]>> = {
  CREATED: ['UPLOADING', 'ABORTED', 'FAILED'],
  UPLOADING: ['UPLOADED', 'REJECTED', 'ABORTED', 'FAILED'],
  UPLOADED: ['SCANNING', 'REJECTED', 'FAILED'],
  SCANNING: ['PROCESSING', 'READY', 'REJECTED', 'FAILED'],
  PROCESSING: ['READY', 'FAILED'],
  READY: [],
  FAILED: [],
  REJECTED: [],
  ABORTED: [],
};

/** Whether a file may move from `from` to `to`. */
export function canMove(from: FileStatus, to: FileStatus): boolean {
  return NEXT[from].includes(to);
}

/** Where a file can still go from `status`: nothing, once it has ended. */
export function nextStatuses(status: FileStatus): readonly FileStatus[] {
  return NEXT[status];
}

/** Whether `status` is an end: READY, or one of the three failures. */
export function isEnded(status: FileStatus): boolean {
  return NEXT[status].length === 0;
}

/**
 * Whether a file's bytes may be served (domain-workflows.md, "Download
 * eligibility"): READY and CLEAN. The owner's current authorization is
 * still required on top (0.8.5): this alone is never permission.
 */
export function isServable(file: {
  readonly status: FileStatus;
  readonly scanVerdict: ScanVerdict;
}): boolean {
  return file.status === 'READY' && file.scanVerdict === 'CLEAN';
}

/**
 * The size of a file, in bytes: a bigint, as the database keeps it — exact
 * past 2 GiB and past JavaScript's safe integers alike.
 */
export type FileSize = bigint;
