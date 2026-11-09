import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { TenantClient } from '../../common/tenancy/tenant-context';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';

/** What Sadara itself records (0.7.3; SR-AUD-001). */
export type SecurityEventType =
  /** A sign-in's callback: a session opened, or the sign-in refused. */
  | 'sign_in'
  /** A step-up's callback: the session's authentication renewed, or refused. */
  | 'step_up'
  /** The member ended this session. */
  | 'sign_out'
  /** The member ended every one of their sessions. */
  | 'sign_out_everywhere'
  /** The member ended one of their sessions from the list, or tried to. */
  | 'session_revoked'
  /** The identity provider's back-channel logout: honoured, or refused. */
  | 'backchannel_logout';

/**
 * Redacted details: codes, counts and ids, never a value a person typed. A
 * key is lowerCamel; a string is at most METADATA_TEXT_MAX characters.
 */
export type SecurityMetadata = Readonly<
  Record<string, string | number | boolean>
>;

/** Who, as the identity provider names them: never a name or an address. */
export interface ProviderIdentity {
  readonly issuer: string;
  readonly subject?: string;
}

/** How it ended: a refusal always says why, as a code (reasonCodeOf). */
type Ending =
  | { readonly outcome: 'SUCCEEDED'; readonly reason?: undefined }
  | { readonly outcome: 'REFUSED'; readonly reason: string };

/** A security event Sadara saw. */
export type SecurityEvent = Ending & {
  readonly type: SecurityEventType;
  /** The tenant the request's host named, if any: a hint, not proof. */
  readonly tenantHint?: string | null;
  readonly identity?: ProviderIdentity;
  /** The Sadara session it concerns. */
  readonly sessionId?: string;
  readonly metadata?: SecurityMetadata;
};

/** The request an event happened in, as far as it is recorded. */
export interface SecurityRequest {
  readonly requestId?: string | null;
  /** Only the address is kept, and only as its keyed hash. */
  readonly client?: TenantClient;
}

/**
 * One of the identity provider's own events (DB-61), as its adapter reads
 * and redacts it: its id at the provider, what happened and when, whom it
 * concerned, the client's address, and codes — never a username, an address
 * a person typed, or the provider's free-form details.
 */
export type ImportedSecurityEvent = Ending & {
  /** `login:<id>` or `admin:<id>`: the same event is imported once. */
  readonly providerEventId: string;
  /** `provider.<type>` or `provider.admin.<resource>.<operation>`. */
  readonly type: string;
  readonly occurredAt: Date;
  readonly identity?: ProviderIdentity;
  /** The client's address as the provider saw it; kept only as its hash. */
  readonly address?: string;
  readonly metadata?: SecurityMetadata;
};

/** Where an event is written: the caller's transaction, or a client of its own. */
export type SecurityEventWriter = Pick<
  Prisma.TransactionClient,
  'securityEvent'
>;

/** The longest string a metadata value holds, in characters. */
export const METADATA_TEXT_MAX = 200;

/** The most metadata a row holds, in bytes of its text: the column's CHECK. */
export const METADATA_BYTES = 4096;

/** The longest event type or reason code: the columns' bound. */
const CODE_MAX = 100;

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const METADATA_KEY = /^[a-z][A-Za-z0-9]{0,39}$/;

/**
 * A security event this service will not write: a type out of form, or
 * metadata that could carry what it must not. A programming error — the
 * request it belonged to fails with it, and nothing is written.
 */
export class SecurityEventRefused extends Error {
  constructor(reason: string) {
    super(`security event refused: ${reason}`);
    this.name = 'SecurityEventRefused';
  }
}

/**
 * A reason as the column holds it: lower case, letters, digits and `_ . : -`,
 * at most 100 characters. `invitation: address` becomes `invitation:address`;
 * anything else outside the set becomes `_`.
 */
export function reasonCodeOf(reason: string): string {
  const code = reason
    .toLowerCase()
    .replace(/:\s+/g, ':')
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, CODE_MAX);
  return code === '' ? 'unknown' : code;
}

/**
 * The address as one form of it, so that one client always hashes alike: a
 * zone dropped, IPv6 compressed and in lower case, an IPv4-mapped IPv6
 * address as its IPv4 address. Null when it is no address.
 */
export function canonicalAddress(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const address = raw.split('%')[0].toLowerCase();
  switch (isIP(address)) {
    case 4:
      return address;
    case 6: {
      const compressed = new URL(`http://[${address}]`).hostname.slice(1, -1);
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
        compressed,
      );
      if (!mapped) return compressed;
      const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
      return [high >> 8, high & 255, low >> 8, low & 255].join('.');
    }
    default:
      return null;
  }
}

/**
 * Security events, with or without a tenant (0.7.3; SR-AUD-001, DB-33,
 * DB-61; docs/reference/database.md). The typed adapter `security_events` is
 * written through: the runtime role may only insert there, so a row is
 * written with `createMany`, which reads nothing back.
 *
 * - `record` writes what Sadara saw. On the caller's transaction when the
 *   event belongs with a change — a session opened, stepped up or ended — so
 *   that both commit or neither; on a client of its own for a refusal, which
 *   changes nothing.
 * - `importFromProvider` writes the identity provider's own events, each
 *   kept once by its id at the provider, however often it is imported.
 *
 * The client's address is kept only as HMAC-SHA-256 under SECURITY_EVENT_KEY:
 * one address gives one hash, so events from it can be found together, and a
 * hash gives no address back. Who is the provider's issuer and subject.
 */
@Injectable()
export class SecurityEvents {
  private readonly key: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.key = config.get('SECURITY_EVENT_KEY', { infer: true });
  }

  /** Records `event`, seen in `request`: on `tx`, or on its own. */
  async record(
    event: SecurityEvent,
    request: SecurityRequest,
    tx: SecurityEventWriter = this.prisma,
  ): Promise<void> {
    await tx.securityEvent.createMany({
      data: [
        {
          source: 'SADARA',
          ...this.rowOf(event, request.client?.address),
          requestId: request.requestId ?? null,
        },
      ],
    });
  }

  /** Imports the provider's events; how many were not already kept. */
  async importFromProvider(
    events: readonly ImportedSecurityEvent[],
  ): Promise<number> {
    if (events.length === 0) return 0;
    const { count } = await this.prisma.securityEvent.createMany({
      data: events.map((event) => ({
        source: 'PROVIDER' as const,
        ...this.rowOf(event, event.address),
        occurredAt: event.occurredAt,
        providerEventId: event.providerEventId,
      })),
      // ON CONFLICT DO NOTHING, which needs no right to read the table.
      skipDuplicates: true,
    });
    return count;
  }

  /** The keyed hash of a client's address; null when it is no address. */
  networkHashOf(address: string | undefined): Uint8Array<ArrayBuffer> | null {
    const canonical = canonicalAddress(address);
    if (canonical === null) return null;
    return new Uint8Array(
      createHmac('sha256', this.key)
        .update(`sadara.security-event.network\n${canonical}`)
        .digest(),
    );
  }

  private rowOf(
    event: (SecurityEvent | ImportedSecurityEvent) & Ending,
    address: string | undefined,
  ) {
    if (!EVENT_TYPE.test(event.type) || event.type.length > CODE_MAX) {
      throw new SecurityEventRefused('the event type is out of form');
    }
    return {
      eventType: event.type,
      outcome: event.outcome,
      reasonCode:
        event.outcome === 'REFUSED' ? reasonCodeOf(event.reason) : null,
      tenantHint: 'tenantHint' in event ? (event.tenantHint ?? null) : null,
      issuer: event.identity?.issuer ?? null,
      subject: event.identity?.subject ?? null,
      sessionId: 'sessionId' in event ? (event.sessionId ?? null) : null,
      networkHash: this.networkHashOf(address),
      metadata: metadataOf(event.metadata),
    };
  }
}

/** Metadata as written: lowerCamel keys, short strings, finite numbers. */
function metadataOf(
  metadata: SecurityMetadata | undefined,
): Prisma.InputJsonObject | undefined {
  if (metadata === undefined) return undefined;
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEY.test(key)) {
      throw new SecurityEventRefused('a metadata key is out of form');
    }
    const fits =
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && [...value].length <= METADATA_TEXT_MAX);
    if (!fits) {
      throw new SecurityEventRefused(`metadata ${key} is out of bounds`);
    }
  }
  // As PostgreSQL prints jsonb: a space after each colon and comma.
  const keys = Object.keys(metadata).length;
  if (Buffer.byteLength(JSON.stringify(metadata)) + 2 * keys > METADATA_BYTES) {
    throw new SecurityEventRefused('the metadata is too large');
  }
  return { ...metadata };
}
