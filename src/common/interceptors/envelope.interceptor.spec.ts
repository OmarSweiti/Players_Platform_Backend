import {
  type CallHandler,
  type ExecutionContext,
  StreamableFile,
} from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { EnvelopeInterceptor } from './envelope.interceptor';

const answer = (value: unknown) =>
  lastValueFrom(
    new EnvelopeInterceptor().intercept(
      {} as ExecutionContext,
      {
        handle: () => of(value),
      } as CallHandler,
    ),
  );

describe('EnvelopeInterceptor', () => {
  it('wraps a resource, a list and nothing in { data }, once', async () => {
    expect(await answer({ id: 'p-1' })).toEqual({ data: { id: 'p-1' } });
    expect(await answer([1, 2])).toEqual({ data: [1, 2] });
    expect(await answer(undefined)).toEqual({ data: null });
    expect(await answer(null)).toEqual({ data: null });
  });

  it('streams a file as it is', async () => {
    const file = new StreamableFile(Buffer.from('%PDF'));
    expect(await answer(file)).toBe(file);
  });
});
