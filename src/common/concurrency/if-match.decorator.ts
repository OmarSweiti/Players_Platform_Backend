import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The request's `If-Match` header: the entity tag an edit was read at. */
export const IfMatch = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<Request>().header('if-match'),
);
