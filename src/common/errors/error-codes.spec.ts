import { describe, expect, it } from 'vitest';
import {
  FIELD_PROBLEMS,
  type ErrorCode,
  PROBLEMS,
  problemTypeOf,
} from './error-codes';

describe('the error contract', () => {
  const codes = Object.keys(PROBLEMS) as ErrorCode[];

  it('gives every code an error status, a title and both languages', () => {
    for (const code of codes) {
      const { status, title, message } = PROBLEMS[code];
      expect([code, status >= 400 && status < 600]).toEqual([code, true]);
      expect(title).not.toBe('');
      expect(message.en).not.toBe('');
      expect(message.ar).toMatch(/[\u0600-\u06FF]/); // written in Arabic
    }
    for (const [code, message] of Object.entries(FIELD_PROBLEMS)) {
      expect([code, message.en.length > 0]).toEqual([code, true]);
      expect(message.ar).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('gives every code its own problem type', () => {
    const types = codes.map(problemTypeOf);
    expect(new Set(types).size).toBe(codes.length);
    for (const type of types)
      expect(type).toMatch(/^urn:sadara:problem:[a-z-]+$/);
    expect(problemTypeOf('VALIDATION_FAILED')).toBe(
      'urn:sadara:problem:validation-failed',
    );
  });
});
