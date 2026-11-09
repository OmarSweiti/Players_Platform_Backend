import { Injectable } from '@nestjs/common';
import { SecurityEvents } from '../../../../infrastructure/audit/security-events';
import { ProviderSecurityEvents } from '../ports/provider-security-events.port';

/** What an import did, without a value of any event. */
export interface SecurityEventImport {
  /** The window's start, as an ISO 8601 instant. */
  readonly since: string;
  /** Events read from the provider and imported, or already kept. */
  readonly read: number;
  readonly imported: number;
  readonly alreadyKept: number;
  /** Events read that were out of form, and not imported. */
  readonly unreadable: number;
  /** False when the limit stopped the read before the window's start. */
  readonly complete: boolean;
}

/**
 * Imports the identity provider's own security events (0.7.3; DB-61): the
 * realm's login events — failed sign-ins, lockouts, second-factor changes,
 * none of which reach Sadara — and its admin events, since an instant. Each
 * is kept once by its id at the provider, so a window read again, or two
 * windows that overlap, import nothing twice. A platform operation, with no
 * tenant: the security-event import runs it (src/cli/import-security-
 * events.ts), and 0.7.6's worker will run it on a schedule.
 */
@Injectable()
export class ImportProviderSecurityEventsUseCase {
  constructor(
    private readonly provider: ProviderSecurityEvents,
    private readonly events: SecurityEvents,
  ) {}

  async execute(input: {
    since: Date;
    limit: number;
  }): Promise<SecurityEventImport> {
    const batch = await this.provider.since(input.since, input.limit);
    const imported = await this.events.importFromProvider(batch.events);
    return {
      since: input.since.toISOString(),
      read: batch.events.length,
      imported,
      alreadyKept: batch.events.length - imported,
      unreadable: batch.unreadable,
      complete: batch.complete,
    };
  }
}
