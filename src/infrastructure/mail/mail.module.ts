import { type DynamicModule, Module } from '@nestjs/common';
import type { WorkerEnv } from '../../config/env.schema';
import { TenantTransactions } from '../../common/tenancy/tenant-transaction';
import { EmailDeliveries } from './email-deliveries';
import { MailTransport } from './mail-transport';
import { SmtpMailTransport } from './smtp-mail-transport';

/** Where an email's links point, for the consumers that write them. */
export interface MailLinks {
  /** A tenant without a domain of its own is {slug}.apexDomain (0.5.2). */
  readonly apexDomain: string;
}
export const MAIL_LINKS = Symbol('MAIL_LINKS');

/**
 * Outgoing email, the worker's (0.7.8): the SMTP transport and the
 * deliveries that record what it sent, from the worker's settings. Global,
 * so that each module's consumer takes it as it takes the outbox.
 */
@Module({})
export class MailModule {
  static forSettings(settings: WorkerEnv): DynamicModule {
    return {
      module: MailModule,
      global: true,
      providers: [
        {
          provide: MailTransport,
          useFactory: () =>
            new SmtpMailTransport({
              host: settings.SMTP_HOST,
              port: settings.SMTP_PORT,
              tls: settings.SMTP_TLS,
              username: settings.SMTP_USERNAME,
              password: settings.SMTP_PASSWORD,
              from: settings.MAIL_FROM,
            }),
        },
        {
          provide: EmailDeliveries,
          inject: [TenantTransactions, MailTransport],
          useFactory: (
            transactions: TenantTransactions,
            transport: MailTransport,
          ) =>
            new EmailDeliveries(
              transactions,
              transport,
              settings.MAIL_FROM.slice(settings.MAIL_FROM.lastIndexOf('@') + 1),
            ),
        },
        {
          provide: MAIL_LINKS,
          useValue: { apexDomain: settings.APEX_DOMAIN } satisfies MailLinks,
        },
      ],
      exports: [MailTransport, EmailDeliveries, MAIL_LINKS],
    };
  }
}
