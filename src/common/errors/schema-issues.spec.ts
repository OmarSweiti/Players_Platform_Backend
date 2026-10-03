import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldIssuesOf, pointerTo } from './schema-issues';

const issuesOf = (schema: z.ZodType, input: unknown) =>
  schema.safeParse(input).error?.issues ?? [];

describe('fieldIssuesOf', () => {
  it('names each field by JSON Pointer, and never its value', () => {
    const schema = z.strictObject({
      name: z.string().max(3),
      age: z.number().int().min(18),
      when: z.iso.date(),
      kind: z.enum(['a', 'b']),
      nested: z.strictObject({ x: z.string() }),
      list: z.array(z.string()).max(1),
    });
    const fieldIssues = fieldIssuesOf(
      issuesOf(schema, {
        name: 'secret-value',
        age: '17',
        when: '2026-02-30',
        kind: 'c',
        nested: { y: 1 },
        list: ['a', 'b'],
        extra: 1,
        'we/ird~key': 2,
      }),
    );

    expect(fieldIssues).toEqual([
      { field: '/name', code: 'TOO_BIG' },
      { field: '/age', code: 'INVALID_TYPE' },
      { field: '/when', code: 'INVALID_FORMAT' },
      { field: '/kind', code: 'INVALID_VALUE' },
      { field: '/nested/x', code: 'REQUIRED' },
      { field: '/nested/y', code: 'UNKNOWN_FIELD' },
      { field: '/list', code: 'TOO_BIG' },
      { field: '/extra', code: 'UNKNOWN_FIELD' },
      { field: '/we~1ird~0key', code: 'UNKNOWN_FIELD' },
    ]);
    expect(JSON.stringify(fieldIssues)).not.toContain('secret-value');
  });

  it('reports a missing value as REQUIRED, and a wrong one by its type', () => {
    // Pins Zod's wording for a missing value: schema-issues.ts reads it.
    const schema = z.strictObject({ name: z.string() });
    expect(fieldIssuesOf(issuesOf(schema, {}))).toEqual([
      { field: '/name', code: 'REQUIRED' },
    ]);
    expect(fieldIssuesOf(issuesOf(schema, { name: 7 }))).toEqual([
      { field: '/name', code: 'INVALID_TYPE' },
    ]);
  });

  it('takes the field code a refinement names, and only a known one', () => {
    const range = (code?: string) =>
      z
        .object({ from: z.number(), to: z.number() })
        .refine(({ from, to }) => from <= to, {
          path: ['to'],
          params: code === undefined ? undefined : { code },
        });
    const reversed = { from: 2, to: 1 };

    expect(fieldIssuesOf(issuesOf(range('OUT_OF_RANGE'), reversed))).toEqual([
      { field: '/to', code: 'OUT_OF_RANGE' },
    ]);
    expect(fieldIssuesOf(issuesOf(range('constructor'), reversed))).toEqual([
      { field: '/to', code: 'INVALID_VALUE' },
    ]);
    expect(fieldIssuesOf(issuesOf(range(), reversed))).toEqual([
      { field: '/to', code: 'INVALID_VALUE' },
    ]);
  });

  it('points at the whole input, or an element, when that is what is wrong', () => {
    expect(
      fieldIssuesOf(issuesOf(z.strictObject({ a: z.string() }), 'text')),
    ).toEqual([{ field: '', code: 'INVALID_TYPE' }]);
    expect(fieldIssuesOf(issuesOf(z.array(z.string()), ['a', 1]))).toEqual([
      { field: '/1', code: 'INVALID_TYPE' },
    ]);
  });
});

describe('pointerTo', () => {
  it('escapes as RFC 6901 does', () => {
    expect(pointerTo(['a', 0, 'b/c', 'd~e'])).toBe('/a/0/b~1c/d~0e');
    expect(pointerTo([])).toBe('');
  });
});
