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
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { testContext } from './fixtures';

/** The headers a test request names its member in, until real sessions exist. */
export const TEST_MEMBER_HEADER = 'x-test-member';
export const TEST_TENANT_HEADER = 'x-test-tenant';

/** The headers that make a test request the member's. */
export function signedInAs(
  member: Pick<User, 'id' | 'tenantId'>,
): Record<string, string> {
  return {
    [TEST_MEMBER_HEADER]: member.id,
    [TEST_TENANT_HEADER]: member.tenantId,
  };
}

/**
 * A stand-in for the sessions of 0.5.6, for tests that need a signed-in
 * member: a request naming a member and their tenant (signedInAs) is that
 * member's, and any other request is refused, as the placeholder SessionGuard
 * refuses them all. The member is looked up as their tenant, the way 0.5.2
 * scopes the sign-in lookup to the tenant of the host: row-level security
 * (0.4.5) shows nothing without one. Installed by bootApp({ testSessions:
 * true }); never in the application.
 */
@Injectable()
export class TestSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantTransactions,
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
    const member = await this.memberOf(
      request.header(TEST_MEMBER_HEADER),
      request.header(TEST_TENANT_HEADER),
    );
    if (!member) throw new UnauthorizedException();

    request.user = member;
    request.tenantId = member.tenantId;
    return true;
  }

  private async memberOf(
    memberId: string | undefined,
    tenantId: string | undefined,
  ): Promise<User | null> {
    if (!memberId || !tenantId) return null;
    let lookup;
    try {
      lookup = testContext(tenantId, 'test-session');
    } catch {
      return null; // not a tenant id: no such member
    }
    return this.tenants.withTenantTransaction(lookup, (tx) =>
      tx.user.findFirst({ where: { id: memberId, tenantId } }),
    );
  }
}
