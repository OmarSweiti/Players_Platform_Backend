/**
 * An upload of one file (0.8.2): its expiry, and how it closes — finalized
 * once the exact bytes are pinned (0.8.3), or aborted. It tracks the upload
 * and defines no competing state machine: the file's status is the file's.
 */
export interface UploadWindow {
  readonly expiresAt: Date;
  readonly finalizedAt: Date | null;
  readonly abortedAt: Date | null;
}

/** Where an upload stands at `at`. */
export type UploadState = 'open' | 'finalized' | 'aborted' | 'expired';

export function uploadStateOf(upload: UploadWindow, at: Date): UploadState {
  if (upload.finalizedAt !== null) return 'finalized';
  if (upload.abortedAt !== null) return 'aborted';
  return upload.expiresAt > at ? 'open' : 'expired';
}

/**
 * What an upload is for, as a declared intent (DB-69): a kind of owner and
 * its id. The owner's policy checks it at upload and again at binding; it is
 * never joined, and the owner's typed binding is the only reference
 * (SR-DB-008).
 */
export interface DeclaredOwner {
  /** Lower-case words joined by hyphens: `player-document`. */
  readonly kind: string;
  readonly id: string;
}

/** A kind of owner, as the database holds one: lower-case words joined by hyphens. */
export const OWNER_KIND = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
