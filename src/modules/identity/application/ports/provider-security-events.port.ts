import type { ImportedSecurityEvent } from '../../../../infrastructure/audit/security-events';

/** What one read of the provider's events brought (0.7.3). */
export interface ProviderEventBatch {
  /** The events read, redacted: whom, what, when, from where, and codes. */
  readonly events: readonly ImportedSecurityEvent[];
  /**
   * Whether every event since the instant asked for was read; false when the
   * read stopped at its bound, and older events in the window were left.
   */
  readonly complete: boolean;
  /** Events read that were out of form, and not imported. */
  readonly unreadable: number;
}

/**
 * The identity provider's own security events (0.7.3; DB-61): the realm's
 * login events — sign-ins and their failures, lockouts, second-factor changes,
 * none of which reach Sadara — and its admin events, read through its
 * authenticated admin API as an account that may read events and nothing
 * else. Only the security-event import wires this; the API never holds it.
 */
export abstract class ProviderSecurityEvents {
  /**
   * The login and admin events from `since` on, newest first, at most
   * `limit` of each kind.
   */
  abstract since(since: Date, limit: number): Promise<ProviderEventBatch>;
}
