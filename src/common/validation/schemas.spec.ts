import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldIssuesOf } from '../errors/schema-issues';
import {
  dayOrInstant,
  flag,
  IdParams,
  line,
  nonEmpty,
  paging,
} from './schemas';

/** The field issues a schema reports for an input, or [] if it passes. */
const issuesOf = (schema: z.ZodType, input: unknown) =>
  fieldIssuesOf(schema.safeParse(input).error?.issues ?? []);

describe('request schema building blocks', () => {
  it('reads a flag as exactly true or false', () => {
    expect(flag.parse('true')).toBe(true);
    expect(flag.parse('false')).toBe(false);
    for (const truthy of ['yes', '1', 'TRUE', '']) {
      expect(flag.safeParse(truthy).success).toBe(false);
    }
  });

  it('pages from 1, 20 at a time, at most 100', () => {
    const page = z.strictObject(paging);
    expect(page.parse({})).toEqual({ page: 1, limit: 20 });
    expect(page.parse({ page: '2', limit: '5' })).toEqual({
      page: 2,
      limit: 5,
    });
    expect(issuesOf(page, { page: '0', limit: '101' })).toEqual([
      { field: '/page', code: 'TOO_SMALL' },
      { field: '/limit', code: 'TOO_BIG' },
    ]);
    expect(issuesOf(page, { page: 'two' })).toEqual([
      { field: '/page', code: 'INVALID_TYPE' },
    ]);
  });

  it('trims a line and refuses one left empty', () => {
    expect(line(10).parse('  Sprain ')).toBe('Sprain');
    expect(issuesOf(line(10), '   ')).toEqual([
      { field: '', code: 'TOO_SMALL' },
    ]);
    expect(issuesOf(line(10), 'Hamstring strain')).toEqual([
      { field: '', code: 'TOO_BIG' },
    ]);
  });

  it('refuses an empty change', () => {
    const patch = nonEmpty(z.strictObject({ name: z.string() }).partial());
    expect(issuesOf(patch, {})).toEqual([{ field: '', code: 'TOO_SMALL' }]);
    expect(issuesOf(patch, { name: undefined })).toEqual([
      { field: '', code: 'TOO_SMALL' },
    ]);
    // Nothing it names is left to change, so both are said.
    expect(issuesOf(patch, { role: 'ADMIN' })).toEqual([
      { field: '/role', code: 'UNKNOWN_FIELD' },
      { field: '', code: 'TOO_SMALL' },
    ]);
    expect(patch.parse({ name: 'Sami' })).toEqual({ name: 'Sami' });
  });

  it('takes a path id only as a UUID, and nothing beside it', () => {
    expect(issuesOf(IdParams, { id: 'not-a-uuid' })).toEqual([
      { field: '/id', code: 'INVALID_FORMAT' },
    ]);
    expect(
      issuesOf(IdParams, {
        id: '6f1c2a9e-4b7d-4c1e-9a3f-2d5e8b7c6a10',
        tenantId: 'x',
      }),
    ).toEqual([{ field: '/tenantId', code: 'UNKNOWN_FIELD' }]);
  });

  it('bounds a query by a day or an instant, and nothing looser', () => {
    for (const valid of ['2026-10-03', '2026-10-03T14:00:00+03:00']) {
      expect(dayOrInstant.safeParse(valid).success).toBe(true);
    }
    for (const invalid of ['2026-13-01', 'yesterday', '03/10/2026']) {
      expect(dayOrInstant.safeParse(invalid).success).toBe(false);
    }
  });
});
