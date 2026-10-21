import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';
import {
  currentRequestId,
  jobCorrelation,
  runCorrelatedJob,
  runWithRequestId,
} from './correlation';

const REQUEST = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f5a6';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A logger that records the bindings each job's logging context starts with. */
function contextRecorder() {
  const bindings: unknown[] = [];
  const logger = {
    runInContext: <T>(fn: () => T, options?: { bindings?: unknown }) => {
      bindings.push(options?.bindings);
      return fn();
    },
  } as unknown as PinoLogger;
  return { logger, bindings };
}

describe('jobCorrelation', () => {
  it('carries the id of the request that enqueues the job', () => {
    expect(runWithRequestId(REQUEST, () => jobCorrelation())).toEqual({
      requestId: REQUEST,
    });
  });

  it('starts a new correlation for work no request caused', () => {
    expect(currentRequestId()).toBeUndefined();
    expect(jobCorrelation().requestId).toMatch(UUID_V7);
  });
});

describe('runCorrelatedJob', () => {
  it('runs the handler as part of the request that enqueued the job', async () => {
    const { logger, bindings } = contextRecorder();
    const job = {
      id: '17',
      attemptsMade: 1,
      data: { correlation: { requestId: REQUEST.toUpperCase() } },
    };

    const runningIn = await runCorrelatedJob(logger, job, () =>
      Promise.resolve(currentRequestId()),
    );

    expect(runningIn).toBe(REQUEST); // so the jobs it enqueues carry it on
    expect(bindings).toEqual([{ requestId: REQUEST, jobId: '17', attempt: 2 }]);
  });

  it('starts a new correlation for a job without a well-formed one', async () => {
    for (const data of [
      undefined,
      'a payload',
      {},
      { correlation: REQUEST },
      { correlation: { requestId: 'job-1' } },
    ]) {
      const { logger, bindings } = contextRecorder();
      const runningIn = await runCorrelatedJob(
        logger,
        { attemptsMade: 0, data },
        () => Promise.resolve(currentRequestId()),
      );
      expect(runningIn).toMatch(UUID_V7);
      expect(bindings).toEqual([{ requestId: runningIn, attempt: 1 }]);
    }
  });
});
