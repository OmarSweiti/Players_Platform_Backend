import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  CsrfFailedError,
  UnsupportedMediaTypeError,
} from '../errors/domain-error';
import type { RequestSession } from '../interfaces/request-with-user.interface';
import { hostOf } from '../tenancy/tenant-resolver';
import { CSRF_HEADER, CsrfTokens } from './csrf-tokens';

/** Methods that change nothing: they carry no CSRF token. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every write a session makes must show it came from the member's own page
 * (0.5.6; ADR-0003, ADR-0023, SR-ACL-007). A cookie alone proves nothing: the
 * browser attaches it to a request any site can make. So a write needs all
 * three, each of which another site cannot supply:
 *
 *   1. `Sec-Fetch-Site: same-origin`, when the browser sends fetch metadata;
 *   2. an `Origin` that is exactly this host's, over HTTPS;
 *   3. the session's synchronizer token in `X-CSRF-Token`
 *      (`GET /api/v1/auth/session` hands it out).
 *
 * Any failure is `403 CSRF_FAILED`. A write's body must then be JSON, which
 * no plain HTML form can send: anything else is `415`. Reads and public
 * routes are exempt; a public route acts for no session, so a forged request
 * has nothing to borrow. A global guard, after the session guard, whose
 * session it checks.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: CsrfTokens,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { session?: RequestSession }>();
    if (SAFE.has(request.method)) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const { session } = request;
    if (!session) throw new CsrfFailedError('a write without a session');
    const site = request.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin') {
      throw new CsrfFailedError('a write from another site');
    }
    const host = hostOf(request);
    if (host === null || request.header('origin') !== `https://${host}`) {
      throw new CsrfFailedError('a write from another origin');
    }
    if (!this.tokens.holds(session.tokenHash, request.header(CSRF_HEADER))) {
      throw new CsrfFailedError('a write without the session token');
    }
    if (hasBody(request) && !request.is('application/json')) {
      throw new UnsupportedMediaTypeError('a body that is not JSON');
    }
    return true;
  }
}

/** Whether the request carries a body, as HTTP says (RFC 9112, 6.3). */
function hasBody(request: Request): boolean {
  const length = request.header('content-length');
  return (
    request.header('transfer-encoding') !== undefined ||
    (length !== undefined && length !== '0')
  );
}
