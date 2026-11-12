import { hostname } from 'node:os';
import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { WorkerEnv } from './config/env.schema';
import { WorkerLoggingModule } from './infrastructure/logging/logging.module';
import { MailModule } from './infrastructure/mail/mail.module';
import { MailTransport } from './infrastructure/mail/mail-transport';
import { ConsumerInboxes } from './infrastructure/outbox/consumer-inboxes';
import {
  OUTBOX_CONSUMERS,
  type OutboxConsumer,
} from './infrastructure/outbox/outbox-consumers';
import { OutboxRelay, RELAY } from './infrastructure/outbox/outbox-relay';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import {
  DELIVERY,
  OUTBOX_QUEUE,
  OutboxPublisher,
  queueConnection,
} from './infrastructure/queue/outbox-queue';
import {
  OutboxJobHandler,
  OutboxWorker,
} from './infrastructure/queue/outbox-worker';
import { RelayLoop } from './infrastructure/queue/relay-loop';
import { TenantRegistry } from './infrastructure/tenancy/tenant-registry';
import { InvitationNoticeConsumer } from './modules/users/application/invitation-notice.consumer';
import { InvitationNoticeModule } from './modules/users/invitation-notice.module';
import { ScanningModule } from './infrastructure/scanning/scanning.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { ScanFileConsumer } from './modules/files/application/scan-file.handler';
import { FileScanModule } from './modules/files/file-scan.module';

/** How many jobs one worker process runs at once. */
const CONCURRENCY = 4;

/**
 * Starts and stops the worker's parts in order (0.7.6): the queue's worker,
 * then the relay; on shutdown, the relay first, then the jobs running are
 * drained, then the queue's connection closes. The registry's and the
 * database's close after, with the application (src/worker.ts).
 */
@Injectable()
export class WorkerLifecycle {
  constructor(
    private readonly loop: RelayLoop,
    private readonly worker: OutboxWorker,
    private readonly publisher: OutboxPublisher,
    private readonly mail: MailTransport,
  ) {}

  start(): void {
    this.worker.start();
    this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
    await this.worker.close();
    await this.publisher.close();
    await this.mail.close();
  }
}

/**
 * The worker's composition root (0.7.6; docs/reference/architecture.md): the
 * runtime role's database for the tenant transactions it works in, the
 * registry role's for finding the active tenants, Valkey for its queue, the
 * outbox relay, the queue's worker with the registered consumers, the SMTP
 * server they send email through (0.7.8), and the object store and the
 * malware scanner a file's scan uses (0.8.4) — no routes, nothing of the
 * API's sessions or identity provider. Its settings are validated before it
 * is built (src/worker.ts).
 */
@Module({})
export class WorkerModule {
  static forSettings(settings: WorkerEnv): DynamicModule {
    const connection = queueConnection(
      settings.REDIS_HOST,
      settings.REDIS_PORT,
    );
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: () => settings,
        }),
        WorkerLoggingModule,
        PrismaModule,
        MailModule.forSettings(settings),
        InvitationNoticeModule,
        // The scan and the promotion (0.8.4): the store, the scanner, the consumer.
        StorageModule,
        ScanningModule,
        FileScanModule,
      ],
      providers: [
        {
          provide: TenantRegistry,
          useFactory: () => new TenantRegistry(settings.REGISTRY_DATABASE_URL),
        },
        {
          provide: OutboxPublisher,
          useFactory: () =>
            new OutboxPublisher(
              new Queue(OUTBOX_QUEUE, { connection }),
              DELIVERY,
            ),
        },
        // Every consumer the worker runs, each for its own event types.
        {
          provide: OUTBOX_CONSUMERS,
          inject: [InvitationNoticeConsumer, ScanFileConsumer],
          useFactory: (
            notice: InvitationNoticeConsumer,
            scan: ScanFileConsumer,
          ): OutboxConsumer[] => [notice, scan],
        },
        {
          provide: OutboxRelay,
          inject: [TenantRegistry, PrismaService, OutboxPublisher],
          useFactory: (
            registry: TenantRegistry,
            prisma: PrismaService,
            publisher: OutboxPublisher,
          ) =>
            new OutboxRelay(registry, prisma, publisher, {
              ...RELAY,
              owner: `${hostname()}:${process.pid}`,
            }),
        },
        {
          provide: OutboxJobHandler,
          inject: [
            PrismaService,
            ConsumerInboxes,
            OUTBOX_CONSUMERS,
            PinoLogger,
          ],
          useFactory: (
            prisma: PrismaService,
            inboxes: ConsumerInboxes,
            consumers: OutboxConsumer[],
            logger: PinoLogger,
          ) => new OutboxJobHandler(prisma, inboxes, consumers, logger),
        },
        {
          provide: OutboxWorker,
          inject: [OutboxJobHandler, PrismaService],
          useFactory: (handler: OutboxJobHandler, prisma: PrismaService) =>
            new OutboxWorker(connection, OUTBOX_QUEUE, handler, prisma, {
              concurrency: CONCURRENCY,
            }),
        },
        {
          provide: RelayLoop,
          inject: [OutboxRelay],
          useFactory: (relay: OutboxRelay) =>
            new RelayLoop(relay, undefined, settings.WORKER_HEARTBEAT_FILE),
        },
        WorkerLifecycle,
      ],
    };
  }
}
