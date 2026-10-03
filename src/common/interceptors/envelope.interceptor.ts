import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/** A success, as every route answers one (docs/reference/api.md). */
export interface Success<T> {
  data: T;
}

/**
 * Wraps every success in `{ data }`, exactly once: a controller returns the
 * resource itself, never a body of its own making. A command with nothing to
 * return answers `{ data: null }`; a file streams as it is. Errors never come
 * through here — they are problems (problem-details.filter.ts).
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(
        map((data: unknown) =>
          data instanceof StreamableFile ? data : { data: data ?? null },
        ),
      );
  }
}
