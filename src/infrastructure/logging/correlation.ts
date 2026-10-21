import { AsyncLocalStorage } from 'node:async_hooks';
import type { PinoLogger } from 'nestjs-pino';
import { v7 as uuidv7 } from 'uuid';

// One id follows a request through everything it causes (SR-CORE-008): the
// request id is the correlation, and jobs carry it on. It travels in the
// async context — log correlation only, never authorization or a query's
// scope (docs/reference/architecture.md).
const context = new AsyncLocalStorage<string>();

/**
 * An RFC 9562 UUID, versions 1 to 8, in its canonical form — never the nil or
 * the max UUID, and nothing a log line or `urn:uuid:` could not hold.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether `value` may serve as a request id. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A new request id: a UUIDv7, so ids sort by when they were made. */
export function newRequestId(): string {
  return uuidv7();
}

/** Runs `fn` as part of the request `requestId` names. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return context.run(requestId, fn);
}

/** The id of the request — or of the job — the current code runs for. */
export function currentRequestId(): string | undefined {
  return context.getStore();
}

/** What a job carries from the request, or the job, that enqueued it. */
export interface JobCorrelation {
  requestId: string;
}

/**
 * The correlation of a job enqueued now: the current request's id, or a new
 * one for work no request caused.
 */
export function jobCorrelation(): JobCorrelation {
  return { requestId: currentRequestId() ?? newRequestId() };
}

/** The parts of a BullMQ job that correlate its logs. */
export interface CorrelatedJob {
  id?: string;
  attemptsMade: number;
  data: unknown;
}

/**
 * Runs a job's handler as part of the request that enqueued it: every line it
 * logs carries that `requestId`, its `jobId` and its `attempt`, and the jobs it
 * enqueues carry the same `requestId` on. A job without a well-formed
 * correlation starts a new one.
 */
export function runCorrelatedJob<T>(
  logger: Pick<PinoLogger, 'runInContext'>,
  job: CorrelatedJob,
  handler: () => Promise<T>,
): Promise<T> {
  const requestId = requestIdOf(job.data) ?? newRequestId();
  const bindings = {
    requestId,
    ...(job.id === undefined ? {} : { jobId: job.id }),
    attempt: job.attemptsMade + 1,
  };
  return runWithRequestId(requestId, () =>
    logger.runInContext(handler, { bindings }),
  );
}

function requestIdOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { correlation } = data as { correlation?: unknown };
  if (typeof correlation !== 'object' || correlation === null) return undefined;
  const { requestId } = correlation as { requestId?: unknown };
  return isRequestId(requestId) ? requestId.toLowerCase() : undefined;
}
