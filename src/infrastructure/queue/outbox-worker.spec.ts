import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  DependencyUnavailableError,
  ValidationFailedError,
} from '../../common/errors/domain-error';
import { errorCodeOf, JobFailedForGood, JobRefused } from './outbox-worker';

// What the outbox records of a failed delivery (0.7.6): a code, never a
// message — a message may hold a value.

describe('a failed delivery, as recorded', () => {
  it('a_failure_is_recorded_as_a_code_never_its_message', () => {
    expect(
      errorCodeOf(new DependencyUnavailableError('owner@agency.test')),
    ).toBe('dependency_unavailable');
    expect(errorCodeOf(new ValidationFailedError('x', []))).toBe(
      'validation_failed',
    );
    expect(errorCodeOf(new JobRefused('its tenant holds no such event'))).toBe(
      'jobrefused',
    );
    expect(errorCodeOf(new UnrecoverableError('a value'))).toBe(
      'unrecoverableerror',
    );
    class Odd extends Error {
      override name = 'Odd Error / with spaces';
    }
    expect(errorCodeOf(new Odd('a value'))).toBe('odd_error_with_spaces');
    expect(errorCodeOf('a string thrown')).toBe('unknown');
    expect(errorCodeOf(new Error('owner@agency.test'))).toBe('error');
    // A code the error carries itself (0.7.8): a system's or a server's.
    expect(
      errorCodeOf(
        Object.assign(new Error('a value'), { code: 'ECONNREFUSED' }),
      ),
    ).toBe('econnrefused');
    expect(errorCodeOf(new JobFailedForGood('smtp_550'))).toBe('smtp_550');
    // Never a code that could be a value.
    expect(
      errorCodeOf(
        Object.assign(new Error('a value'), { code: 'owner@agency.test x' }),
      ),
    ).toBe('error');
  });
});
