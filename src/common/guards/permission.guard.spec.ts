import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionService } from '../../modules/users/application/services/permission.service';
import { RequirePermission } from '../decorators/permissions.decorator';
import { Public } from '../decorators/public.decorator';
import { SignedIn } from '../decorators/signed-in.decorator';
import { ForbiddenError } from '../errors/domain-error';
import { PermissionGuard } from './permission.guard';

// The permission guard (0.6.2) on its own: what each declaration lets
// through, and that a route declaring none, or two, is refused.

class Routes {
  @Public()
  open() {}

  @SignedIn()
  own() {}

  @RequirePermission('user.invite')
  invite() {}

  undeclared() {}

  @Public()
  @RequirePermission('user.invite')
  twice() {}
}

const ctx = { tenantId: 't' };

function guardFor(holds: boolean) {
  const hasPermission = vi.fn().mockResolvedValue(holds);
  const guard = new PermissionGuard(new Reflector(), {
    hasPermission,
  } as unknown as PermissionService);
  const run = (handler: keyof Routes, tenantContext: unknown = ctx) =>
    guard.canActivate({
      // Read as metadata, never called.
      getHandler: () =>
        Object.getOwnPropertyDescriptor(Routes.prototype, handler)
          ?.value as unknown,
      getClass: () => Routes,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: 'COACH' }, tenantContext }),
      }),
    } as unknown as ExecutionContext);
  return { run, hasPermission };
}

describe('the permission guard', () => {
  it('lets_a_public_or_signed_in_route_through_without_asking_for_a_permission', async () => {
    const { run, hasPermission } = guardFor(false);
    await expect(run('open', null)).resolves.toBe(true);
    await expect(run('own')).resolves.toBe(true);
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('asks_whether_the_member_role_holds_the_route_permission', async () => {
    const allowed = guardFor(true);
    await expect(allowed.run('invite')).resolves.toBe(true);
    expect(allowed.hasPermission).toHaveBeenCalledWith(
      ctx,
      'COACH',
      'user.invite',
    );
    await expect(guardFor(false).run('invite')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses_a_route_declaring_none_or_two_and_a_request_without_a_member', async () => {
    const { run, hasPermission } = guardFor(true);
    await expect(run('undeclared')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run('twice')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run('invite', null)).rejects.toBeInstanceOf(ForbiddenError);
    expect(hasPermission).not.toHaveBeenCalled();
  });
});
