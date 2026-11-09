import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Actor, AuthorizedTenantContext } from '../tenancy/tenant-context';
import { AUDIT_SCHEMA_VERSION, auditedChangeOf } from './audit-actor';

// What an audit row says about who made a change (0.7.1): the context's actor,
// as it held it. Only the minters make a context (eslint.config.mjs): here a
// plain one stands in, since nothing below asks whether it was minted.

const REQUEST = randomUUID();
const contextOf = (actor: Actor) =>
  ({
    tenantId: randomUUID(),
    actor,
    requestId: REQUEST,
    locale: 'en',
  }) as unknown as AuthorizedTenantContext;

describe('the audited change', () => {
  it('a_member_is_recorded_with_the_role_and_session_they_acted_in', () => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    expect(
      auditedChangeOf(
        contextOf({ kind: 'USER', userId, sessionId, role: 'ADMIN' } as Actor),
      ),
    ).toEqual({
      actorType: 'USER',
      userId,
      actorRole: 'ADMIN',
      actorSessionId: sessionId,
      actorJob: null,
      requestId: REQUEST,
      outcome: 'SUCCEEDED',
      schemaVersion: AUDIT_SCHEMA_VERSION,
    });
  });

  it('a_job_is_recorded_as_the_system_never_as_a_member', () => {
    expect(
      auditedChangeOf(contextOf({ kind: 'SYSTEM', job: 'tenant:provision' })),
    ).toEqual({
      actorType: 'SYSTEM',
      userId: null,
      actorRole: null,
      actorSessionId: null,
      actorJob: 'tenant:provision',
      requestId: REQUEST,
      outcome: 'SUCCEEDED',
      schemaVersion: AUDIT_SCHEMA_VERSION,
    });
  });
});
