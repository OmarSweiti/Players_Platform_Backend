import type { ErrorCode, FieldErrorCode } from './error-codes';

/** A field the client got wrong: a JSON Pointer into what it sent, and why. */
export interface FieldIssue {
  readonly field: string; // `/dateOfBirth`; '' is the whole input
  readonly code: FieldErrorCode;
}

/**
 * An error a client can act on, thrown instead of a plain `Error`. Its code
 * (error-codes.ts) decides the HTTP status, the problem type and the message
 * the client reads. The message given here is for the developer reading a
 * stack trace or a test: it is never sent, and never logged.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;

  constructor(
    message: string,
    readonly fieldIssues: readonly FieldIssue[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Missing, or not readable by this caller: the answer never says which. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
}

/** The caller may see this, but may not do this to it. */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
}

/** The input breaks a rule; `fieldIssues` names the fields. */
export class ValidationFailedError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
}

/** The change conflicts with the data as it stands. */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
}

/** The resource's state does not allow this action. */
export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_TRANSITION';
}
