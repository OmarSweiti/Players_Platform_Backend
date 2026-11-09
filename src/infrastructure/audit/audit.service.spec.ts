import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  Actor,
  AuthorizedTenantContext,
  TenantClient,
} from '../../common/tenancy/tenant-context';
import type { TenantTx } from '../../common/tenancy/tenant-transaction';
import {
  AuditEventRefused,
  AuditService,
  USER_AGENT_MAX,
} from './audit.service';
import type { AuditEvent } from './audited-actions';

// The audit service's payload and client rules (0.7.2), on a transaction that
// only collects what it is asked to write. Only the minters make a context
// (eslint.config.mjs): a plain one stands in, since nothing below asks
// whether it was minted.

const MEMBER: Actor = {
  kind: 'USER',
  userId: randomUUID(),
  sessionId: randomUUID(),
  role: 'OWNER',
} as Actor;

const contextOf = (client?: TenantClient) =>
  ({
    tenantId: randomUUID(),
    actor: MEMBER,
    requestId: randomUUID(),
    locale: 'en',
    ...(client ? { client } : {}),
  }) as unknown as AuthorizedTenantContext;

/** A transaction that keeps what the service writes, and writes nothing. */
function collecting() {
  const written: Array<Record<string, unknown>> = [];
  const tx = {
    auditLog: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return Promise.resolve({ id: randomUUID() });
      },
    },
  } as unknown as TenantTx;
  return { tx, written };
}

const audit = new AuditService();

describe('the audit service', () => {
  it('records_an_allowlisted_delta_with_personal_values_as_references', async () => {
    const { tx, written } = collecting();
    const id = randomUUID();
    const expiresAt = new Date('2026-11-16T10:00:00.000Z');
    await audit.record(tx, contextOf(), {
      action: 'invitation.created',
      entityId: id,
      after: {
        email: 'invitee@agency.test',
        role: 'COACH',
        locale: 'ar',
        expiresAt,
      },
    });
    expect(written).toEqual([
      expect.objectContaining({
        action: 'invitation.created',
        entityType: 'Invitation',
        entityId: id,
        reason: null,
        oldValues: undefined,
        newValues: {
          email: { ref: `Invitation/${id}/email`, class: 'PERSONAL' },
          role: 'COACH',
          locale: 'ar',
          expiresAt: '2026-11-16T10:00:00.000Z',
        },
        schemaVersion: 2,
        outcome: 'SUCCEEDED',
      }),
    ]);
    expect(JSON.stringify(written)).not.toContain('invitee@agency.test');
  });

  it('refuses_a_field_the_action_does_not_list', async () => {
    const { tx, written } = collecting();
    const event = {
      action: 'invitation.revoked',
      entityId: randomUUID(),
      after: { status: 'revoked', body: { email: 'x@agency.test' } },
    } as unknown as AuditEvent;
    await expect(audit.record(tx, contextOf(), event)).rejects.toThrow(
      new AuditEventRefused('invitation.revoked lists no field body'),
    );
    expect(written).toEqual([]);
  });

  it('refuses_a_nested_value', async () => {
    const { tx } = collecting();
    const event = {
      action: 'invitation.revoked',
      entityId: randomUUID(),
      after: { status: { nested: 'revoked' } },
    } as unknown as AuditEvent;
    await expect(audit.record(tx, contextOf(), event)).rejects.toBeInstanceOf(
      AuditEventRefused,
    );
  });

  it('a_role_change_needs_its_state_before_and_after', async () => {
    const { tx, written } = collecting();
    const entityId = randomUUID();
    for (const event of [
      { action: 'member.role_changed', entityId, after: { role: 'SCOUT' } },
      { action: 'member.role_changed', entityId, before: { role: 'COACH' } },
    ] as AuditEvent<'member.role_changed'>[]) {
      await expect(audit.record(tx, contextOf(), event)).rejects.toThrow(
        new AuditEventRefused(
          'member.role_changed records role before and after',
        ),
      );
    }
    await audit.record(tx, contextOf(), {
      action: 'member.role_changed',
      entityId,
      before: { role: 'COACH' },
      after: { role: 'SCOUT' },
    });
    expect(written).toEqual([
      expect.objectContaining({
        oldValues: { role: 'COACH' },
        newValues: { role: 'SCOUT' },
      }),
    ]);
  });

  it('refuses_an_over_long_reason', async () => {
    const { tx } = collecting();
    await expect(
      audit.record(tx, contextOf(), {
        action: 'invitation.revoked',
        entityId: randomUUID(),
        after: { status: 'revoked' },
        reason: 'x'.repeat(501),
      }),
    ).rejects.toBeInstanceOf(AuditEventRefused);
  });

  it('keeps_only_client_values_that_cannot_fail_the_insert', async () => {
    const recorded = async (client?: TenantClient) => {
      const { tx, written } = collecting();
      await audit.record(tx, contextOf(client), {
        action: 'invitation.revoked',
        entityId: randomUUID(),
        after: { status: 'revoked' },
      });
      const [{ ipAddress, userAgent }] = written;
      return { ipAddress, userAgent };
    };
    // An address inet takes: kept, a zone dropped.
    expect(await recorded({ address: '203.0.113.7' })).toEqual({
      ipAddress: '203.0.113.7',
      userAgent: null,
    });
    expect(await recorded({ address: 'fe80::1%en0' })).toEqual({
      ipAddress: 'fe80::1',
      userAgent: null,
    });
    expect(await recorded({ address: '::ffff:198.51.100.4' })).toEqual({
      ipAddress: '::ffff:198.51.100.4',
      userAgent: null,
    });
    // One it would refuse: not recorded, and the change goes on.
    for (const address of ['203.0.113.300', 'unknown', '']) {
      expect(await recorded({ address })).toEqual({
        ipAddress: null,
        userAgent: null,
      });
    }
    // A user agent cut to its bound, by characters, not halfway through one.
    const arabic = 'متصفح'.repeat(200);
    const { userAgent } = await recorded({ userAgent: arabic });
    expect([...(userAgent as string)].length).toBe(USER_AGENT_MAX);
    expect(arabic.startsWith(userAgent as string)).toBe(true);
    expect(await recorded()).toEqual({ ipAddress: null, userAgent: null });
  });

  it('an_acceptance_names_the_new_member_and_no_session', async () => {
    const { tx, written } = collecting();
    const memberId = randomUUID();
    await audit.recordAcceptance(
      tx,
      {
        tenantId: randomUUID(),
        memberId,
        role: 'SCOUT',
        requestId: null,
      },
      {
        action: 'invitation.accepted',
        entityId: randomUUID(),
        before: { status: 'pending' },
        after: { status: 'accepted', memberId, role: 'SCOUT' },
      },
    );
    expect(written).toEqual([
      expect.objectContaining({
        actorType: 'USER',
        userId: memberId,
        actorRole: 'SCOUT',
        requestId: null,
        outcome: 'SUCCEEDED',
        schemaVersion: 2,
        oldValues: { status: 'pending' },
        newValues: { status: 'accepted', memberId, role: 'SCOUT' },
      }),
    ]);
    expect(written[0]).not.toHaveProperty('actorSessionId');
  });
});
