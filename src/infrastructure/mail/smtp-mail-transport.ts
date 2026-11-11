import { createTransport, type Transporter } from 'nodemailer';
import {
  type MailLocale,
  MailNotSent,
  MailTransport,
  type OutgoingMail,
} from './mail-transport';

/** The SMTP server and the sender, from the worker's settings (WorkerEnv). */
export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** `implicit` TLS from the first byte, `starttls` required after connecting, or `none` (Mailpit). */
  readonly tls: 'implicit' | 'starttls' | 'none';
  readonly username?: string;
  readonly password?: string;
  readonly from: string;
}

/** The sender's name, in the email's language. */
const SENDER: Record<MailLocale, string> = { ar: 'صدارة', en: 'Sadara' };

/** The client's codes for a message the server will never take, whatever is tried. */
const ENVELOPE_REFUSED = new Set(['EENVELOPE', 'EMESSAGE']);

/** A failure as the code a delivery records, and whether trying again could help. */
export function notSentOf(error: unknown): MailNotSent {
  const { responseCode, code } = (error ?? {}) as {
    responseCode?: unknown;
    code?: unknown;
  };
  if (typeof responseCode === 'number') {
    return new MailNotSent(
      `smtp_${responseCode}`,
      responseCode >= 500 && responseCode < 600,
    );
  }
  if (typeof code === 'string' && /^[A-Z][A-Z_]{1,40}$/.test(code)) {
    return new MailNotSent(code.toLowerCase(), ENVELOPE_REFUSED.has(code));
  }
  return new MailNotSent('mail_failed', false);
}

/**
 * Outgoing email over SMTP (0.7.8), through nodemailer: one pooled
 * connection, bounded waits, and no attachment read from a path or a URL. A
 * message is plain text and HTML in UTF-8, from the sender in its language,
 * marked as automatic (`Auto-Submitted`), so that no one's out-of-office
 * answers it.
 */
export class SmtpMailTransport extends MailTransport {
  private readonly transporter: Transporter;

  constructor(private readonly settings: SmtpSettings) {
    super();
    const { host, port, tls, username, password } = settings;
    this.transporter = createTransport({
      host,
      port,
      secure: tls === 'implicit',
      requireTLS: tls === 'starttls',
      ignoreTLS: tls === 'none',
      auth:
        username !== undefined && password !== undefined
          ? { user: username, pass: password }
          : undefined,
      pool: true,
      maxConnections: 1,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: { name: SENDER[mail.locale], address: this.settings.from },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        messageId: mail.messageId,
        headers: { 'Auto-Submitted': 'auto-generated' },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      throw notSentOf(error);
    }
  }

  close(): Promise<void> {
    this.transporter.close();
    return Promise.resolve();
  }
}
