import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User } from '@prisma/client';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';

/** The header a test request names its member in, until real sessions exist. */
export const TEST_MEMBER_HEADER = 'x-test-member';

/**
 * A stand-in for the sessions of 0.5.6, for tests that need a signed-in
 * member: a request naming a member in `x-test-member` is that member's, and
 * any other request is refused, as the placeholder SessionGuard refuses them
 * all. Installed by bootApp({ testSessions: true }); never in the application.
 */
@Injectable()
export class TestSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User; tenantId?: string }>();
    const memberId = request.header(TEST_MEMBER_HEADER);
    const member = memberId
      ? await this.prisma.user.findUnique({ where: { id: memberId } })
      : null;
    if (!member) throw new UnauthorizedException();

    request.user = member;
    request.tenantId = member.tenantId;
    return true;
  }
}
