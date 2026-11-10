/** One outbox event's catalog entry: what it is about, and what its payload names. */
interface OutboxEventDefinition {
  /** The entity the event is about: its aggregate type. */
  readonly aggregate: string;
  /** The payload's shape version: raised when `refs` changes. */
  readonly version: number;
  /** The identifiers its payload carries, each a UUID: nothing else. */
  readonly refs: readonly string[];
}

/**
 * Every outbox event, and the allowlist of what its payload carries (0.7.5;
 * I-10). A payload is identifiers only — never a value, a name, a link or a
 * token — so a consumer loads what it needs under its tenant's policies, and
 * an event leaks nothing on its way. An event enters here with its producer.
 */
export const OUTBOX_EVENTS = {
  // The invitation notice (0.7.8): its handler loads the invitation and sends
  // the email, generating the token at send time; the event carries the
  // invitation's id, never a link.
  'invitation.created': {
    aggregate: 'Invitation',
    version: 1,
    refs: ['invitationId'],
  },
} as const satisfies Readonly<Record<string, OutboxEventDefinition>>;

export type OutboxEventType = keyof typeof OUTBOX_EVENTS;

/** An event's payload: each identifier its entry names, and no other. */
export type OutboxRefs<T extends OutboxEventType> = {
  readonly [K in (typeof OUTBOX_EVENTS)[T]['refs'][number]]: string;
};
