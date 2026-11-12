import { DomainError } from '../../../common/errors/domain-error';

/** Completing an upload whose file has not arrived (0.8.3): send it, then complete. */
export class UploadIncompleteError extends DomainError {
  readonly code = 'UPLOAD_INCOMPLETE';
}

/**
 * The file that arrived is not the one declared (0.8.3; SR-DOC-003): its
 * size, its type, or its first bytes. The message names which, for the log;
 * the code alone is answered.
 */
export class UploadContentMismatchError extends DomainError {
  readonly code = 'UPLOAD_CONTENT_MISMATCH';
}
