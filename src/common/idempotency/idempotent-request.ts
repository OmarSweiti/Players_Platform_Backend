import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { ValidationFailedError } from '../errors/domain-error';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_KEY = 'sadara:idempotent';

/** A key: 1 to 128 printable ASCII characters, no space (docs/reference/api.md). */
const KEY = /^[!-~]{1,128}$/;

/** The longest canonical path a record keeps (`canonical_path VARCHAR(512)`). */
export const CANONICAL_PATH_MAX = 512;

const COMMAND_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type CommandMethod = (typeof COMMAND_METHODS)[number];

/**
 * What binds a retried command to its first execution, besides who sends it
 * (the context): the operation — its method and canonical path, the route
 * with its parameters filled in — the client's key, and the precondition the
 * request was sent with.
 */
export interface IdempotentRequest {
  readonly key: string;
  readonly method: CommandMethod;
  readonly canonicalPath: string;
  readonly ifMatch?: string;
}

/** A route that cannot take a key: a programming error, answered as a 500. */
export class IdempotentRouteRefused extends Error {
  constructor(reason: string) {
    super(`this route cannot take an idempotency key: ${reason}`);
    this.name = 'IdempotentRouteRefused';
  }
}

/**
 * The route the request took, with its parameters filled in: the same
 * resource or action, whatever the query string says, is the same path. A
 * route with an optional part or a wildcard has no one canonical form, and
 * cannot take a key.
 */
function canonicalPathOf(request: Request): string {
  const template: unknown = (request.route as { path?: unknown } | undefined)
    ?.path;
  if (typeof template !== 'string' || !template.startsWith('/')) {
    throw new IdempotentRouteRefused('the request took no route');
  }
  if (/[{}*]/.test(template)) {
    throw new IdempotentRouteRefused(`${template} has no one canonical form`);
  }
  const params = request.params as Record<string, string | undefined>;
  return template.replace(/:(\w+)/g, (_match, name: string) =>
    encodeURIComponent(params[name] ?? ''),
  );
}

/**
 * The idempotent request a command was sent as: its `Idempotency-Key`, which
 * a missing or malformed one refuses with 400, its method and canonical path,
 * and its `If-Match`.
 */
export function idempotentRequestOf(request: Request): IdempotentRequest {
  const method = request.method.toUpperCase();
  if (!(COMMAND_METHODS as readonly string[]).includes(method)) {
    throw new IdempotentRouteRefused(`${method} changes nothing`);
  }
  const key = request.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || !KEY.test(key)) {
    throw new ValidationFailedError(
      `${IDEMPOTENCY_KEY_HEADER} is missing, or not 1 to 128 printable characters`,
    );
  }
  const canonicalPath = canonicalPathOf(request);
  if (canonicalPath.length > CANONICAL_PATH_MAX) {
    throw new ValidationFailedError(
      `the path is longer than ${CANONICAL_PATH_MAX} characters`,
    );
  }
  return {
    key,
    method: method as CommandMethod,
    canonicalPath,
    ifMatch: request.header('if-match'),
  };
}

/**
 * Marks the route as an idempotent command, for the contract: it requires
 * `Idempotency-Key`, and can answer 409 while its first execution runs or
 * when its key was used for another request (src/common/openapi).
 */
const declareIdempotent: ParameterDecorator = (target, key) => {
  if (key === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) return;
  Reflect.defineMetadata(IDEMPOTENT_KEY, true, descriptor.value as object);
  ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'A key of the client’s, 1 to 128 printable characters, sent again unchanged with every retry of this request: a retry is answered with the first outcome, without a second effect',
  })(target, key, descriptor);
};

/**
 * The route's idempotent request (`IdempotentRequest`): a command a client
 * may retry takes it, and runs through `Idempotency.run` (0.7.7).
 */
export const Idempotent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IdempotentRequest =>
    idempotentRequestOf(context.switchToHttp().getRequest<Request>()),
  [declareIdempotent],
);
