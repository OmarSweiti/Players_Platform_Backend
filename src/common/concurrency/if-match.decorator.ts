import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';

export const IF_MATCH_KEY = 'sadara:if-match';

/**
 * Marks the route as an edit of a revisioned resource, for the contract: it
 * requires `If-Match` and can answer 412 and 428 (src/common/openapi).
 */
const declareIfMatch: ParameterDecorator = (target, key) => {
  if (key === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) return;
  Reflect.defineMetadata(IF_MATCH_KEY, true, descriptor.value as object);
  ApiHeader({
    name: 'If-Match',
    required: true,
    description:
      'The ETag of the version being edited: a stale one is refused with 412, a missing one with 428',
  })(target, key, descriptor);
};

/** The request's `If-Match` header: the entity tag an edit was read at. */
export const IfMatch = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<Request>().header('if-match'),
  [declareIfMatch],
);
