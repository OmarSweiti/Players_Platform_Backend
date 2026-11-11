/** The languages an email is written in. */
export type MailLocale = 'ar' | 'en';

/** One message, as a template made it, for one recipient. */
export interface OutgoingMail {
  readonly to: string;
  readonly locale: MailLocale;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Its Message-ID, `<…@…>`: one per attempt, so a resent message is not taken for the last. */
  readonly messageId: string;
}

/**
 * Why a message was not sent, as a code a delivery records: the server's
 * reply code (`smtp_451`) or the client's (`econnection`), never the
 * server's text, which can quote the address. `permanent` when the server
 * refused the message itself (a 5xx reply, or an envelope it will never
 * take): trying again changes nothing.
 */
export class MailNotSent extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(`mail not sent: ${code}`);
    this.name = 'MailNotSent';
  }
}

/**
 * Where outgoing email goes (0.7.8): SMTP (smtp-mail-transport.ts), Mailpit
 * locally; the production provider is 1.6.3's. `send` resolves once the
 * server accepted the message, and throws `MailNotSent` otherwise. A provider
 * that offers an idempotency key would take one here.
 */
export abstract class MailTransport {
  abstract send(mail: OutgoingMail): Promise<void>;
  abstract close(): Promise<void>;
}
