import { randomBytes } from 'node:crypto';
import { type Tenant, UserRole } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from '../../src/modules/users/domain/permission-catalog';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createTenant,
  runPrisma,
} from '../harness/fixtures';
import { signedInAs } from '../harness/session';

// Effective permissions for the web app (0.6.6). `GET /api/v1/auth/session`
// lists what the member's role holds, read from the stored matrix on every
// request, so the web app can shape its navigation. For every tenant role in
// two tenants the list is that role's stored grants, in the catalog's order,
// and it agrees with what the API decides on a route behind a permission. A
// role change shows on the member's next request, in the same session. The
// list is display only: the API still decides every call.

type Role = Exclude<UserRole, 'SUPER_ADMIN'>;

/** Every tenant role; SUPER_ADMIN holds no tenant membership (0.6.7). */
const ROLES = Object.values(UserRole).filter(
  (role): role is Role => role !== 'SUPER_ADMIN',
);

/** A route the API serves behind one permission (users/presentation/invitations.controller.ts). */
const INVITATIONS = {
  path: '/api/v1/users/invitations',
  permission: 'user.invite',
} as const;

const suffix = () => randomBytes(4).toString('hex');

interface SessionAnswer {
  member: { role: UserRole };
  permissions: string[];
}

describe('effective permissions for the web app', () => {
  let booted: BootedApp;
  let tenants: Tenant[];

  /**
   * The names of the permissions the database's matrix grants `role`, read
   * apart from the API: the matrix belongs to no tenant.
   */
  async function storedGrants(role: UserRole): Promise<string[]> {
    const grants = await runPrisma().rolePermission.findMany({
      where: { roleId: role },
      select: { permission: { select: { name: true } } },
    });
    return grants.map(({ permission }) => permission.name).sort();
  }

  /** The catalog's order, of the keys `listed` names. */
  const inCatalogOrder = (listed: readonly string[]) =>
    PERMISSION_KEYS.filter((key) => listed.includes(key));

  async function sessionOf(
    headers: Record<string, string>,
  ): Promise<SessionAnswer> {
    const response = await booted.http.get('/api/v1/auth/session').set(headers);
    expect(response.status).toBe(200);
    return (response.body as { data: SessionAnswer }).data;
  }

  const invitationsAs = async (headers: Record<string, string>) =>
    (await booted.http.get(INVITATIONS.path).set(headers)).status;

  beforeAll(async () => {
    booted = await bootApp();
    tenants = [
      await createTenant({ slug: `agency-${suffix()}` }),
      await createTenant({ slug: `rival-${suffix()}` }),
    ];
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  it('the_session_lists_effective_permissions', async () => {
    const answered = new Set<number>();
    for (const tenant of tenants) {
      for (const role of ROLES) {
        const headers = await signedInAs(await createMember(tenant, role));
        const { member, permissions } = await sessionOf(headers);

        // The role's stored grants: every one, nothing else, once each…
        expect([tenant.slug, member.role, [...permissions].sort()]).toEqual([
          tenant.slug,
          role,
          await storedGrants(role),
        ]);
        // …in the catalog's order, a stable one for the web app.
        expect(permissions).toEqual(inCatalogOrder(permissions));

        // And the API agrees: the route serves the member exactly when the
        // list says the member may use it.
        const status = await invitationsAs(headers);
        expect([tenant.slug, role, status]).toEqual([
          tenant.slug,
          role,
          permissions.includes(INVITATIONS.permission) ? 200 : 403,
        ]);
        answered.add(status);
      }
    }
    // Both sides of the agreement were seen: some roles invite, most do not.
    expect([...answered].sort()).toEqual([200, 403]);
  });

  it('a_role_change_applies_on_the_next_request', async () => {
    const [tenant] = tenants;
    // A privileged member, signed in with a second factor, as sign-in requires.
    const member = await createMember(tenant, 'ADMIN');
    const headers = await signedInAs(member);
    const changeRole = (role: UserRole) =>
      asTenant(tenant.id, (tx) =>
        tx.user.update({ where: { id: member.id }, data: { role } }),
      );

    const asAdmin = await sessionOf(headers);
    expect(asAdmin.member.role).toBe('ADMIN');
    expect(asAdmin.permissions).toContain(INVITATIONS.permission);
    expect(await invitationsAs(headers)).toBe(200);

    // The role changes between two requests of one session: the next
    // request lists the new role's permissions, and the API decides by them.
    await changeRole('COACH');
    const asCoach = await sessionOf(headers);
    expect(asCoach.member.role).toBe('COACH');
    expect([...asCoach.permissions].sort()).toEqual(
      await storedGrants('COACH'),
    );
    expect(asCoach.permissions).not.toContain(INVITATIONS.permission);
    expect(await invitationsAs(headers)).toBe(403);

    // And back: what the role holds again shows at once too.
    await changeRole('ADMIN');
    const again = await sessionOf(headers);
    expect([...again.permissions].sort()).toEqual(await storedGrants('ADMIN'));
    expect(again.permissions).toEqual(asAdmin.permissions);
    expect(await invitationsAs(headers)).toBe(200);
  });
});
