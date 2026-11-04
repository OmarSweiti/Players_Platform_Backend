import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  assertAuthorizedTenantContext,
  type AuthorizedTenantContext,
} from '../tenancy/tenant-context';

/**
 * The verified tenant context of the request (0.4.12; ADR-0004): the one the
 * session guard minted for the signed-in member (0.5.6; until then, in tests,
 * the test session guard). A handler passes it to its use case; it never
 * builds one, and never takes a tenant from the request. A route that reaches
 * its handler without one is a guard's fault, refused rather than served.
 */
export const CurrentTenantContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthorizedTenantContext => {
    const { tenantContext } = context
      .switchToHttp()
      .getRequest<{ tenantContext?: unknown }>();
    assertAuthorizedTenantContext(tenantContext);
    return tenantContext;
  },
);
