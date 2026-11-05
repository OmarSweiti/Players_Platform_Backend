import { randomUUID } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SessionService } from '../../modules/identity/application/session.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { localeOf } from '../errors/locale';
import type {
  RequestSession,
  SessionMember,
} from '../interfaces/request-with-user.interface';
import { requestIdOf } from '../logging/request-id';
import { SESSION_COOKIE } from '../security/session-cookies';
import {
  type AuthorizedTenantContext,
  mintTenantContext,
} from '../tenancy/tenant-context';

type SessionRequest = Request & {
  user?: SessionMember;
  tenantId?: string;
  session?: RequestSession;
  tenantContext?: AuthorizedTenantContext;
};

/**
 * Every route that is not @Public() needs a session (0.5.6; ADR-0003): the
 * `__Host-Http-sadara_session` cookie sign-in issued (0.5.5), checked against
 * PostgreSQL on every request (SessionService). A request it holds for gets
 * its member, its tenant, its session, and the tenant context its handler
 * works in: the guard is where a request's context is minted (0.4.3), from
 * the session alone — never from anything the request names. Anything else
 * is refused before a handler runs.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<SessionRequest>();
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const { sessionId, tokenHash, member } = await this.sessions.authenticate({
      arrival: request,
      token: cookies?.[SESSION_COOKIE],
    });
    request.user = member;
    request.tenantId = member.tenantId;
    request.session = { id: sessionId, tokenHash };
    request.tenantContext = mintTenantContext({
      tenantId: member.tenantId,
      actor: { kind: 'USER', userId: member.id, sessionId },
      requestId: requestIdOf(request) ?? randomUUID(),
      locale: localeOf(request.header('accept-language')),
    });
    return true;
  }
}
