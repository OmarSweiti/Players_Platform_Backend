import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldIssuesOf } from '../errors/schema-issues';
import { anyOf, filtersOf, listQuery, search } from './list-query';

const issuesOf = (schema: z.ZodType, input: unknown) =>
  fieldIssuesOf(schema.safeParse(input).error?.issues ?? []);

const PlayersQuery = listQuery({
  status: anyOf(['ACTIVE', 'INJURED', 'RETIRED']).optional(),
  q: search().optional(),
});

describe('a list endpoint query', () => {
  it('a_limit_above_100_is_refused', () => {
    expect(issuesOf(PlayersQuery, { limit: '101' })).toEqual([
      { field: '/limit', code: 'TOO_BIG' },
    ]);
    expect(issuesOf(PlayersQuery, { limit: '0' })).toEqual([
      { field: '/limit', code: 'TOO_SMALL' },
    ]);
    expect(PlayersQuery.parse({ limit: '100' }).limit).toBe(100);
    expect(PlayersQuery.parse({})).toEqual({
      sort: 'createdAt:desc',
      limit: 25,
    });
  });

  it('an_unlisted_filter_is_refused', () => {
    expect(issuesOf(PlayersQuery, { nationality: 'JO' })).toEqual([
      { field: '/nationality', code: 'UNKNOWN_FIELD' },
    ]);
    expect(issuesOf(PlayersQuery, { status: 'SOLD' })).toEqual([
      { field: '/status', code: 'INVALID_VALUE' },
    ]);
    expect(issuesOf(PlayersQuery, { sort: 'name:asc' })).toEqual([
      { field: '/sort', code: 'INVALID_VALUE' },
    ]);
  });

  it('reads a listed filter, once or repeated, and bounds a search', () => {
    expect(PlayersQuery.parse({ status: 'ACTIVE' }).status).toEqual(['ACTIVE']);
    expect(
      PlayersQuery.parse({ status: ['ACTIVE', 'INJURED'] }).status,
    ).toEqual(['ACTIVE', 'INJURED']);
    expect(PlayersQuery.parse({ q: '  Sami ' }).q).toBe('Sami');
    expect(issuesOf(PlayersQuery, { q: 'x'.repeat(101) })).toEqual([
      { field: '/q', code: 'TOO_BIG' },
    ]);
  });

  it('binds a cursor to the filters only, not to the page', () => {
    const query = PlayersQuery.parse({
      status: 'ACTIVE',
      limit: '10',
      cursor: 'abc',
    });
    expect(filtersOf(query)).toEqual({ status: ['ACTIVE'] });
  });
});
