import { DomainError } from '../../../common/errors/domain-error';

/**
 * A file whose bytes nothing serves (0.8.5; SR-DOC-002): not `READY` and
 * `CLEAN` — its scan pending, refused or never reached — or purged. The
 * member may read the file; there is just nothing to give them. The message
 * names why, for the log; the code alone is answered.
 */
export class FileUnavailableError extends DomainError {
  readonly code = 'FILE_UNAVAILABLE';
}
