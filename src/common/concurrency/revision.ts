import { createHash } from 'node:crypto';
import { DomainError } from '../errors/domain-error';

/** An edit that did not say which revision it read: no If-Match. */
export class PreconditionRequiredError extends DomainError {
  readonly code = 'PRECONDITION_REQUIRED';
}

/** An edit of a revision that is no longer the current one. */
export class RevisionMismatchError extends DomainError {
  readonly code = 'REVISION_MISMATCH';
}

/** An editable aggregate: its `revision Int @default(1)` counts its changes. */
export interface Revisioned {
  readonly id: string;
  readonly revision: number;
}

/**
 * The strong, opaque entity tag of a resource as one caller sees it, bound
 * to the kind of resource, its id, its revision and the caller's projection
 * (the fields they may read): a tag carries across none of them.
 */
export function etagOf(
  kind: string,
  resource: Revisioned,
  projection: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([kind, resource.id, resource.revision, projection]))
    .digest('base64url');
  return `"${digest}"`;
}

/**
 * The revision an edit may change: the current one, if `ifMatch` is the tag
 * the caller would be served now. Missing is 428; anything else — a stale
 * tag, a weak one, `*`, a list — is 412, so a client edits only what it read.
 */
export function revisionToChange(
  ifMatch: string | undefined,
  current: { etag: string; revision: number },
): number {
  if (ifMatch === undefined || ifMatch.trim() === '') {
    throw new PreconditionRequiredError('An edit needs If-Match');
  }
  if (ifMatch.trim() !== current.etag) {
    throw new RevisionMismatchError('The resource changed since it was read');
  }
  return current.revision;
}

/**
 * After the compare-and-update — `WHERE id AND tenantId AND revision`, with
 * `revision = revision + 1` — no changed row means another edit won.
 */
export function assertChanged(count: number): void {
  if (count === 0) {
    throw new RevisionMismatchError('Another edit changed it first');
  }
}
