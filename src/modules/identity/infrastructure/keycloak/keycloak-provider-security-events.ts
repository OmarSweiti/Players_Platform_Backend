import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { EventImportEnv } from '../../../../config/env.schema';
import type {
  ImportedSecurityEvent,
  ProviderIdentity,
} from '../../../../infrastructure/audit/security-events';
import {
  type ProviderEventBatch,
  ProviderSecurityEvents,
} from '../../application/ports/provider-security-events.port';
import { KeycloakAdminApi } from './keycloak-admin-api';

/** How many events one call asks for: Keycloak's own default page. */
export const PAGE_SIZE = 100;

/** A Keycloak event or session id: its UUIDs, or an id of that alphabet. */
const ID = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
/** A Keycloak constant: an event type, an operation, a resource type. */
const CONSTANT = z.string().regex(/^[A-Z][A-Z0-9_]{0,60}$/);
/** An error code Keycloak writes (`invalid_user_credentials`). */
const ERROR_CODE = z.string().regex(/^[a-z][a-z0-9_]{0,60}$/);
/** A client id as this realm names its clients (`sadara-api`). */
const CLIENT_ID = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/);

/**
 * What is read of a login event, and nothing else: its free-form `details`
 * hold what a person typed (the username), and are never read. A field out
 * of form makes the event unreadable rather than imported in part.
 */
const LoginEvent = z.object({
  id: ID,
  time: z.number().int().nonnegative(),
  type: CONSTANT,
  realmId: z.string().optional(),
  clientId: z.string().optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  ipAddress: z.string().optional(),
  error: z.string().optional(),
});

/** What is read of an admin event: never its representation or details. */
const AdminEvent = z.object({
  id: ID,
  time: z.number().int().nonnegative(),
  realmId: z.string().optional(),
  operationType: CONSTANT,
  resourceType: CONSTANT,
  resourcePath: z.string().optional(),
  error: z.string().optional(),
  authDetails: z
    .object({
      realmId: z.string().optional(),
      clientId: z.string().optional(),
      userId: z.string().optional(),
      ipAddress: z.string().optional(),
    })
    .optional(),
});

/** The longest event type: the column's bound. */
const TYPE_MAX = 100;

/** An OpenID Connect subject: at most 255 ASCII characters, no spaces. */
const SUBJECT = /^[\x21-\x7e]{1,255}$/;
/** A UUID, as Keycloak's ids are. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** An admin resource's path: words and ids only (`users/<id>/role-mappings`). */
const RESOURCE_PATH = new RegExp(
  `^(?:[a-z][a-z_-]*|${UUID})(?:/(?:[a-z][a-z_-]*|${UUID}))*$`,
);

/**
 * The realm's login and admin events at Keycloak (0.7.3; DB-61), read as the
 * event reader's service account `OIDC_EVENTS_CLIENT_ID`, which the realm
 * lets read events and nothing else (the umbrella's infra/keycloak/realm-
 * sadara.json). Only the security-event import wires this; the API never
 * holds that account.
 *
 * Each kind is read newest first, a page at a time from `dateFrom`, until a
 * page comes back short or the limit is reached. Each event is redacted as
 * it is read: its id, type, time, the subject it concerns, the client's
 * address and codes — never the username or other details a person typed,
 * and a client id only when the provider found that client. The subject is
 * kept only when it is this realm's, so that it pairs with this issuer.
 */
@Injectable()
export class KeycloakProviderSecurityEvents extends ProviderSecurityEvents {
  private readonly adminApi: KeycloakAdminApi;
  private readonly issuer: string;

  constructor(config: ConfigService<EventImportEnv, true>) {
    super();
    this.issuer = config.get('OIDC_ISSUER', { infer: true });
    this.adminApi = new KeycloakAdminApi(new URL(this.issuer), {
      clientId: config.get('OIDC_EVENTS_CLIENT_ID', { infer: true }),
      clientSecret: config.get('OIDC_EVENTS_CLIENT_SECRET', { infer: true }),
    });
  }

  async since(since: Date, limit: number): Promise<ProviderEventBatch> {
    const [login, admin] = [
      await this.read('/events', since, limit),
      await this.read('/admin-events', since, limit),
    ];
    const events: ImportedSecurityEvent[] = [];
    let unreadable = 0;
    for (const raw of login.events) {
      const event = this.loginEventOf(raw);
      if (event) events.push(event);
      else unreadable += 1;
    }
    for (const raw of admin.events) {
      const event = this.adminEventOf(raw);
      if (event) events.push(event);
      else unreadable += 1;
    }
    return { events, complete: login.complete && admin.complete, unreadable };
  }

  /** One kind's events from `since`, a page at a time, at most `limit`. */
  private async read(
    path: '/events' | '/admin-events',
    since: Date,
    limit: number,
  ): Promise<{ events: unknown[]; complete: boolean }> {
    const events: unknown[] = [];
    while (events.length < limit) {
      const max = Math.min(PAGE_SIZE, limit - events.length);
      const query = new URLSearchParams({
        dateFrom: String(since.getTime()),
        first: String(events.length),
        max: String(max),
      });
      const response = await this.adminApi.call('GET', `${path}?${query}`);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw this.adminApi.unexpected('read events', response.status);
      }
      const page: unknown = await response.json();
      if (!Array.isArray(page)) {
        throw this.adminApi.unexpected('read events', response.status);
      }
      events.push(...(page as unknown[]));
      if (page.length < max) return { events, complete: true };
    }
    return { events, complete: false };
  }

  private loginEventOf(raw: unknown): ImportedSecurityEvent | null {
    const parsed = LoginEvent.safeParse(raw);
    if (!parsed.success) return null;
    const event = parsed.data;
    const type = `provider.${event.type.toLowerCase()}`;
    if (type.length > TYPE_MAX) return null;
    const error = this.errorOf(event.error);
    const refused = error !== undefined || event.type.endsWith('_ERROR');
    const metadata: Record<string, string> = {};
    // A client the provider did not find is a name someone typed.
    if (
      error !== 'client_not_found' &&
      CLIENT_ID.safeParse(event.clientId).success
    ) {
      metadata.clientId = event.clientId as string;
    }
    if (ID.safeParse(event.sessionId).success) {
      metadata.providerSessionId = event.sessionId as string;
    }
    return {
      providerEventId: `login:${event.id}`,
      type,
      occurredAt: new Date(event.time),
      ...(refused
        ? { outcome: 'REFUSED', reason: error ?? 'error' }
        : { outcome: 'SUCCEEDED' }),
      identity: this.identityOf(event.userId),
      address: event.ipAddress,
      metadata,
    };
  }

  private adminEventOf(raw: unknown): ImportedSecurityEvent | null {
    const parsed = AdminEvent.safeParse(raw);
    if (!parsed.success) return null;
    const event = parsed.data;
    const type = `provider.admin.${event.resourceType.toLowerCase()}.${event.operationType.toLowerCase()}`;
    if (type.length > TYPE_MAX) return null;
    const error = this.errorOf(event.error);
    const by = event.authDetails;
    const metadata: Record<string, string> = {};
    if (CLIENT_ID.safeParse(by?.clientId).success) {
      metadata.clientId = by?.clientId as string;
    }
    if (
      event.resourcePath !== undefined &&
      event.resourcePath.length <= 200 &&
      RESOURCE_PATH.test(event.resourcePath)
    ) {
      metadata.resourcePath = event.resourcePath;
    }
    return {
      providerEventId: `admin:${event.id}`,
      type,
      occurredAt: new Date(event.time),
      ...(event.error !== undefined
        ? { outcome: 'REFUSED', reason: error ?? 'error' }
        : { outcome: 'SUCCEEDED' }),
      // Who acted: only someone of this realm pairs with this issuer.
      identity:
        by?.realmId !== undefined && by.realmId === event.realmId
          ? this.identityOf(by.userId)
          : undefined,
      address: by?.ipAddress,
      metadata,
    };
  }

  private identityOf(
    subject: string | undefined,
  ): ProviderIdentity | undefined {
    return subject !== undefined && SUBJECT.test(subject)
      ? { issuer: this.issuer, subject }
      : undefined;
  }

  /** The provider's error code, when it is one; never free text. */
  private errorOf(error: string | undefined): string | undefined {
    if (error === undefined) return undefined;
    return ERROR_CODE.safeParse(error).success ? error : 'other';
  }
}
