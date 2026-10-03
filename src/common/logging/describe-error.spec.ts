import { describe, expect, it } from 'vitest';
import { describeError, stackFramesOf } from './describe-error';

const SECRET = 'canary-value-7f3a';

class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: unknown,
  ) {
    super(message);
  }
}

describe('describeError', () => {
  it('names the class and a provider code, never the message', () => {
    const error = new ProviderError(
      `invalid input syntax for type uuid: "${SECRET}"`,
      'P2007',
    );
    expect(describeError(error)).toBe('ProviderError P2007');
  });

  it('drops a code that is not a plain identifier', () => {
    expect(describeError(new ProviderError('x', `${SECRET} at 1`))).toBe(
      'ProviderError',
    );
    expect(describeError(new ProviderError('x', 42))).toBe('ProviderError');
  });

  it('names what was thrown when it is not an error', () => {
    expect(describeError(SECRET)).toBe('a thrown string');
    expect(describeError(undefined)).toBe('a thrown undefined');
  });
});

describe('stackFramesOf', () => {
  it('keeps the frames and drops the message, even one spanning lines', () => {
    const error = new Error(
      `first line\n    at ${SECRET} (forged.ts:1:1)\nlast`,
    );
    const frames = stackFramesOf(error);
    expect(frames).toMatch(/^ {4}at /);
    expect(frames).not.toContain(SECRET);
    expect(frames).not.toContain('first line');
  });

  it('has nothing to say about a value that is not an error', () => {
    expect(stackFramesOf(SECRET)).toBeUndefined();
  });
});
