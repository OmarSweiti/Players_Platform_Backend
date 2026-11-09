import { createHmac, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import {
  canonicalAddress,
  type ImportedSecurityEvent,
  reasonCodeOf,
  type SecurityEvent,
  SecurityEventRefused,
  SecurityEvents,
  type SecurityEventWriter,
} from './security-events';

// The security events' typed adapter (0.7.3): what a row holds, on a client
// that only collects what it is asked to write.

const KEY = 'not-a-real-event-key-not-a-real-event-key';

/** A client that keeps what the service writes, and writes nothing. */
function collecting() {
  const calls: Array<{ data: Record<string, unknown>[]; skip?: boolean }> = [];
  const db = {
    securityEvent: {
      createMany: ({
        data,
        skipDuplicates,
      }: {
        data: Record<string, unknown>[];
        skipDuplicates?: boolean;
      }) => {
        calls.push({ data, skip: skipDuplicates });
        return Promise.resolve({ count: data.length - 1 });
      },
    },
  };
  const service = new SecurityEvents(
    db as unknown as PrismaService,
    { get: () => KEY } as unknown as ConfigService<Env, true>,
  );
  return { service, calls, tx: db as unknown as SecurityEventWriter };
}

const hmac = (address: string) =>
  new Uint8Array(
    createHmac('sha256', KEY)
      .update(`sadara.security-event.network\n${address}`)
      .digest(),
  );

describe('security events', () => {
  it('records_what_sadara_saw_with_the_address_hashed', async () => {
    const { service, calls, tx } = collecting();
    const tenantId = randomUUID();
    const sessionId = randomUUID();
    await service.record(
      {
        type: 'sign_in',
        outcome: 'SUCCEEDED',
        tenantHint: tenantId,
        identity: {
          issuer: 'https://idp.agency.test/realms/sadara',
          subject: 'sub-1',
        },
        sessionId,
        metadata: { acr: '2', amr: 'otp pwd' },
      },
      {
        requestId: 'request-1',
        client: { address: '203.0.113.7', userAgent: 'Browser/1.0' },
      },
      tx,
    );
    expect(calls).toEqual([
      {
        data: [
          {
            source: 'SADARA',
            eventType: 'sign_in',
            outcome: 'SUCCEEDED',
            reasonCode: null,
            tenantHint: tenantId,
            issuer: 'https://idp.agency.test/realms/sadara',
            subject: 'sub-1',
            sessionId,
            networkHash: hmac('203.0.113.7'),
            metadata: { acr: '2', amr: 'otp pwd' },
            requestId: 'request-1',
          },
        ],
        skip: undefined,
      },
    ]);
    // Neither the address nor the user agent is written.
    const written = JSON.stringify(calls, (_key, value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value,
    );
    expect(written).not.toContain('203.0.113.7');
    expect(written).not.toContain('Browser');
  });

  it('a_refusal_without_a_tenant_names_none', async () => {
    const { service, calls, tx } = collecting();
    await service.record(
      { type: 'sign_in', outcome: 'REFUSED', reason: 'invitation: address' },
      { requestId: null },
      tx,
    );
    expect(calls[0].data[0]).toMatchObject({
      outcome: 'REFUSED',
      reasonCode: 'invitation:address',
      tenantHint: null,
      issuer: null,
      subject: null,
      sessionId: null,
      networkHash: null,
      requestId: null,
    });
  });

  it('hashes_one_address_alike_in_every_form', () => {
    const { service } = collecting();
    const forms = [
      ['198.51.100.4', '::ffff:198.51.100.4', '::FFFF:c633:6404'],
      ['2001:db8::1', '2001:DB8:0:0:0:0:0:1', '2001:db8::1%en0'],
    ];
    for (const [first, ...others] of forms) {
      const hash = service.networkHashOf(first);
      expect(hash).toHaveLength(32);
      for (const other of others) {
        expect([other, service.networkHashOf(other)]).toEqual([other, hash]);
      }
    }
    expect(service.networkHashOf('198.51.100.5')).not.toEqual(
      service.networkHashOf('198.51.100.4'),
    );
    for (const nothing of [undefined, '', 'unknown', '198.51.100.300']) {
      expect(service.networkHashOf(nothing)).toBeNull();
    }
    expect(canonicalAddress('fe80::1%en0')).toBe('fe80::1');
  });

  it('keeps_a_reason_to_the_columns_form', () => {
    expect(reasonCodeOf('AUTHENTICATION_REQUIRED')).toBe(
      'authentication_required',
    );
    expect(reasonCodeOf('provider:ERR_JWT_EXPIRED:exp')).toBe(
      'provider:err_jwt_expired:exp',
    );
    expect(reasonCodeOf('a reason, with "words"')).toBe('a_reason_with_words_');
    expect(reasonCodeOf('---')).toBe('unknown');
    expect(reasonCodeOf('x'.repeat(300))).toHaveLength(100);
  });

  it('refuses_metadata_that_could_carry_what_it_must_not', async () => {
    const { service, calls, tx } = collecting();
    const refused: Array<SecurityEvent['metadata']> = [
      { 'user.email': 'x' },
      { Email: 'x' },
      { note: 'x'.repeat(201) },
      { revoked: Number.NaN },
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`key${i}`, 'é'.repeat(80)]),
      ),
    ];
    for (const metadata of refused) {
      await expect(
        service.record(
          { type: 'sign_out', outcome: 'SUCCEEDED', metadata },
          {},
          tx,
        ),
      ).rejects.toBeInstanceOf(SecurityEventRefused);
    }
    await expect(
      service.record(
        { type: 'Sign In' as SecurityEvent['type'], outcome: 'SUCCEEDED' },
        {},
        tx,
      ),
    ).rejects.toThrow(
      new SecurityEventRefused('the event type is out of form'),
    );
    expect(calls).toEqual([]);
  });

  it('imports_the_providers_events_once_each', async () => {
    const { service, calls } = collecting();
    expect(await service.importFromProvider([])).toBe(0);
    expect(calls).toEqual([]);
    const at = new Date('2026-11-09T10:00:00.000Z');
    const events: ImportedSecurityEvent[] = [
      {
        providerEventId: 'login:5f0c',
        type: 'provider.login_error',
        outcome: 'REFUSED',
        reason: 'invalid_user_credentials',
        occurredAt: at,
        identity: {
          issuer: 'https://idp.agency.test/realms/sadara',
          subject: 'sub-2',
        },
        address: '203.0.113.9',
        metadata: { clientId: 'sadara-api' },
      },
      {
        providerEventId: 'admin:77aa',
        type: 'provider.admin.user.create',
        outcome: 'SUCCEEDED',
        occurredAt: at,
      },
    ];
    // The client says how many rows were new: one of the two here.
    expect(await service.importFromProvider(events)).toBe(1);
    expect(calls).toEqual([
      {
        skip: true,
        data: [
          expect.objectContaining({
            source: 'PROVIDER',
            providerEventId: 'login:5f0c',
            eventType: 'provider.login_error',
            outcome: 'REFUSED',
            reasonCode: 'invalid_user_credentials',
            occurredAt: at,
            subject: 'sub-2',
            tenantHint: null,
            networkHash: hmac('203.0.113.9'),
            metadata: { clientId: 'sadara-api' },
          }),
          expect.objectContaining({
            source: 'PROVIDER',
            providerEventId: 'admin:77aa',
            reasonCode: null,
            issuer: null,
            networkHash: null,
            metadata: undefined,
          }),
        ],
      },
    ]);
  });
});
