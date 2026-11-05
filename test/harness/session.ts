import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import {
  CSRF_HEADER,
  csrfTokenOf,
} from '../../src/common/security/csrf-tokens';
import { SESSION_COOKIE } from '../../src/common/security/session-cookies';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from '../../src/modules/identity/domain/session-lifetime';
import { asTenant } from './fixtures';

/** The issuer of the identities the harness links members to: synthetic. */
const TEST_ISSUER = 'https://idp.agency.test/realms/sadara';

/**
 * A real session for `member` (0.5.6), opened as sign-in opens one (0.5.5),
 * and the headers of a request from the member's own page: their tenant's
 * host ({slug}.localhost, as APEX_DOMAIN in the test environment resolves
 * it), the session cookie, that host's Origin, and the session's CSRF token.
 * The real session guard checks them, as it checks a browser's; only a test
 * of sign-in itself goes through the provider. A member with no identity is
 * linked to one first: `provider`'s issuer and subject (found or added), or a
 * new synthetic one; the session carries `provider.sid`, as the provider's
 * session (0.5.7). Every call opens a new session.
 */
export async function signedInAs(
  member: Pick<User, 'id' | 'tenantId'>,
  provider?: { issuer: string; subject: string; sid?: string },
): Promise<Record<string, string>> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest();
  const host = await asTenant(member.tenantId, async (tx) => {
    const linked = await tx.user.findUniqueOrThrow({
      where: { id: member.id },
      select: {
        identity: { select: { id: true, issuer: true, subject: true } },
      },
    });
    const wanted = {
      issuer: provider?.issuer ?? TEST_ISSUER,
      subject: provider?.subject ?? randomUUID(),
    };
    const identity =
      linked.identity ??
      (await tx.identity.findUnique({
        where: { issuer_subject: wanted },
        select: { id: true, issuer: true, subject: true },
      })) ??
      (await tx.identity.create({
        data: wanted,
        select: { id: true, issuer: true, subject: true },
      }));
    if (
      provider &&
      (identity.issuer !== provider.issuer ||
        identity.subject !== provider.subject)
    ) {
      throw new Error('the member is linked to another identity');
    }
    if (!linked.identity) {
      await tx.user.update({
        where: { id: member.id },
        data: { identityId: identity.id },
      });
    }
    const now = Date.now();
    await tx.userSession.create({
      data: {
        tenantId: member.tenantId,
        userId: member.id,
        identityId: identity.id,
        tokenHash: new Uint8Array(tokenHash),
        issuer: identity.issuer,
        subject: identity.subject,
        providerSid: provider?.sid,
        authTime: new Date(now),
        idleExpiresAt: new Date(now + SESSION_IDLE_MS),
        absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_MS),
      },
    });
    const { slug } = await tx.tenant.findUniqueOrThrow({
      where: { id: member.tenantId },
      select: { slug: true },
    });
    return `${slug}.localhost`;
  });
  return {
    Host: host,
    Cookie: `${SESSION_COOKIE}=${token}`,
    Origin: `https://${host}`,
    [CSRF_HEADER]: csrfTokenOf(tokenHash, process.env.CSRF_SECRET ?? ''),
  };
}
