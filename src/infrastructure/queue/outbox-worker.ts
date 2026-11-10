import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  type ConnectionOptions,
  type Job,
  UnrecoverableError,
  Worker,
} from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { DomainError } from '../../common/errors/domain-error';
import { describeError } from '../../common/logging/describe-error';
import { TenantTransactions } from '../../common/tenancy/tenant-transaction';
import { runCorrelatedJob } from '../logging/correlation';
import type { ConsumerInboxes } from '../outbox/consumer-inboxes';
import type {
  DeliveredEvent,
  OutboxConsumer,
} from '../outbox/outbox-consumers';
import type { OutboxEventType } from '../outbox/outbox-events';
import { jobContext } from './job-context';
import { OutboxJobData } from './outbox-queue';

/** A job that names an event its tenant does not hold, or is out of form: never retried. */
export class JobRefused extends UnrecoverableError {
  constructor(reason: string) {
    super(`outbox job refused: ${reason}`);
    this.name = 'JobRefused';
  }
}

/** A failure as the outbox records it: a code, never a message, which may hold a value. */
export function errorCodeOf(error: unknown): string {
  const raw =
    error instanceof DomainError
      ? error.code
      : error instanceof Error
        ? error.name
        : 'unknown';
  const code = raw
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .slice(0, 100);
  return code === '' ? 'unknown' : code;
}

/**
 * Runs an outbox job (0.7.6). It restores the tenant the job names and runs
 * inside the correlation it carries (runCorrelatedJob, 0.10.1). The event is
 * loaded in that tenant's own transaction, under row-level security: a job
 * naming another tenant's event finds nothing, runs nothing, and is refused
 * without a retry. Each consumer of the event's type then runs its effect in
 * a tenant transaction of its own, behind its receipt (ConsumerInboxes.once),
 * so a redelivered job — a worker that crashed after the commit and before
 * acknowledging — commits no effect twice, and one consumer's failure does
 * not undo another's.
 */
export class OutboxJobHandler {
  private readonly transactions: TenantTransactions;

  constructor(
    prisma: Pick<PrismaClient, '$transaction'>,
    private readonly inboxes: Pick<ConsumerInboxes, 'once'>,
    private readonly consumers: readonly OutboxConsumer[],
    private readonly logger: Pick<PinoLogger, 'runInContext'>,
  ) {
    this.transactions = new TenantTransactions(prisma);
  }

  handle(job: Job): Promise<number> {
    const parsed = OutboxJobData.safeParse(job.data);
    if (!parsed.success) {
      return Promise.reject(new JobRefused('its data is out of form'));
    }
    return runCorrelatedJob(this.logger, job, () => this.deliver(parsed.data));
  }

  private async deliver(data: OutboxJobData): Promise<number> {
    const ctx = jobContext(
      data.tenantId,
      'outbox:deliver',
      data.correlation.requestId,
    );
    const event = await this.transactions.withTenantTransaction(ctx, (tx) =>
      tx.outboxEvent.findFirst({
        where: { id: data.eventId, tenantId: data.tenantId },
        select: {
          id: true,
          tenantId: true,
          type: true,
          aggregateType: true,
          aggregateId: true,
          payloadVersion: true,
          payloadRefs: true,
        },
      }),
    );
    if (event === null) {
      throw new JobRefused('its tenant holds no such event');
    }
    const delivered: DeliveredEvent = {
      ...event,
      type: event.type as OutboxEventType,
      payloadRefs: event.payloadRefs as Record<string, string>,
    };
    const consumers = this.consumers.filter((consumer) =>
      consumer.types.includes(delivered.type),
    );
    for (const consumer of consumers) {
      await this.transactions.withTenantTransaction(ctx, (tx) =>
        this.inboxes.once(
          tx,
          ctx,
          { consumer: consumer.name, eventId: delivered.id },
          () => consumer.consume(tx, ctx, delivered),
        ),
      );
    }
    return consumers.length;
  }
}

/** How the worker runs jobs: at once, and how long a job's lock holds. */
export interface WorkerOptions {
  readonly concurrency: number;
  /** How long a running job's lock lasts unless renewed; a crashed worker's job is taken again after it. */
  readonly lockDurationMs?: number;
  /** How often to look for jobs whose lock ran out. */
  readonly stalledIntervalMs?: number;
}

/**
 * The worker side of the queue (0.7.6; SYS-ASY-004): BullMQ runs each outbox
 * job through the handler; a job that fails is retried with the back-off the
 * relay published it with, and every failed attempt is recorded on the event
 * — its attempts and its last error, as a code. After the last attempt, or a
 * refusal, the event is DEAD. A worker that crashes holding a job loses its
 * lock, and the job runs again on another (BullMQ's stalled jobs), once.
 * `close` stops taking jobs and waits for those running: shutdown drains.
 */
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly transactions: TenantTransactions;
  private worker?: Worker;
  private readonly recording = new Set<Promise<void>>();

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly queueName: string,
    private readonly handler: Pick<OutboxJobHandler, 'handle'>,
    prisma: Pick<PrismaClient, '$transaction'>,
    private readonly options: WorkerOptions,
  ) {
    this.transactions = new TenantTransactions(prisma);
  }

  start(): void {
    this.worker = new Worker(
      this.queueName,
      (job: Job) => this.handler.handle(job),
      {
        connection: this.connection,
        concurrency: this.options.concurrency,
        maxStalledCount: 1,
        ...(this.options.lockDurationMs !== undefined
          ? { lockDuration: this.options.lockDurationMs }
          : {}),
        ...(this.options.stalledIntervalMs !== undefined
          ? { stalledInterval: this.options.stalledIntervalMs }
          : {}),
      },
    );
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const recorded = this.recordFailure(job, error).catch((failure) =>
        this.logger.error(
          `an outbox job's failure was not recorded: ${describeError(failure)}`,
        ),
      );
      this.recording.add(recorded);
      void recorded.finally(() => this.recording.delete(recorded));
    });
    this.worker.on('error', (error) =>
      this.logger.warn(`the outbox worker's queue: ${describeError(error)}`),
    );
  }

  /** Stops taking jobs, waits for those running and their records. */
  async close(): Promise<void> {
    await this.worker?.close();
    await Promise.all([...this.recording]);
  }

  private async recordFailure(job: Job, error: Error): Promise<void> {
    const parsed = OutboxJobData.safeParse(job.data);
    if (!parsed.success) return;
    const { tenantId, eventId, correlation } = parsed.data;
    const final =
      error instanceof UnrecoverableError ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    const ctx = jobContext(tenantId, 'outbox:deliver', correlation.requestId);
    // In the job's own tenant: a job naming another tenant's event changes
    // nothing. An event a relay published and did not get to mark is still
    // LEASED: it is recorded too, and a DEAD one gives up its lease.
    await this.transactions.withTenantTransaction(ctx, (tx) =>
      tx.outboxEvent.updateMany({
        where: {
          id: eventId,
          tenantId,
          status: { in: ['PUBLISHED', 'LEASED'] },
        },
        data: {
          attempts: job.attemptsMade,
          lastErrorCode: errorCodeOf(error),
          ...(final
            ? { status: 'DEAD' as const, leaseOwner: null, leaseUntil: null }
            : {}),
        },
      }),
    );
  }
}
