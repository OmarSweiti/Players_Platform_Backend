import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CursorScope,
  encodeCursor,
  InvalidCursorError,
  type Keyset,
} from './cursor';
import { type KeysetArgs, paginate } from './paginate';

interface Row extends Keyset {
  name: string;
}

const at = (second: number) => new Date(Date.UTC(2026, 9, 3, 12, 0, second));
const row = (second: number, name: string): Row => ({
  createdAt: at(second),
  id: randomUUID(),
  name,
});

/** Newest first, the id breaking ties: the order a repository reads in. */
const newestFirst = (a: Row, b: Row) =>
  b.createdAt.getTime() - a.createdAt.getTime() ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** An in-memory table, read as keysetWhere reads a real one. */
function tableOf(rows: Row[]) {
  return ({ take, after }: KeysetArgs): Promise<Row[]> =>
    Promise.resolve(
      [...rows]
        .sort(newestFirst)
        .filter(
          (candidate) =>
            !after ||
            candidate.createdAt < after.createdAt ||
            (candidate.createdAt.getTime() === after.createdAt.getTime() &&
              candidate.id < after.id),
        )
        .slice(0, take),
    );
}

const scope: CursorScope = {
  tenantId: randomUUID(),
  filters: { status: 'ACTIVE', position: 'GOALKEEPER' },
  sort: 'createdAt:desc',
};

describe('paginate', () => {
  it('cursors_stay_stable_under_inserts', async () => {
    // Three rows share a second: only the id orders them.
    const rows = [10, 9, 9, 9, 8, 7, 6].map((second, i) =>
      row(second, `r${i}`),
    );
    const expected = [...rows].sort(newestFirst).map(({ name }) => name);
    const fetch = tableOf(rows);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const { data, page } = await paginate({ limit: 3, cursor, scope }, fetch);
      seen.push(...data.map(({ name }) => name));
      cursor = page.nextCursor ?? undefined;
      // Between pages, newer rows arrive: none may shift a later page.
      rows.push(row(30 + seen.length, `late${seen.length}`));
    } while (cursor);

    expect(seen).toEqual(expected);
  });

  it('a_cursor_from_another_query_is_refused', async () => {
    const fetch = tableOf([5, 4, 3].map((second, i) => row(second, `r${i}`)));
    const first = await paginate({ limit: 1, scope }, fetch);
    const cursor = first.page.nextCursor!;

    const others: CursorScope[] = [
      { ...scope, tenantId: randomUUID() },
      { ...scope, filters: { status: 'INJURED', position: 'GOALKEEPER' } },
      { ...scope, filters: { status: 'ACTIVE' } },
      { ...scope, sort: 'createdAt:asc' },
    ];
    for (const other of others) {
      await expect(
        paginate({ limit: 1, cursor, scope: other }, fetch),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    }

    // The same query, its filters listed in another order, goes on.
    const sameQuery = {
      ...scope,
      filters: { position: 'GOALKEEPER', status: 'ACTIVE' },
    };
    const second = await paginate(
      { limit: 1, cursor, scope: sameQuery },
      fetch,
    );
    expect(second.data).toHaveLength(1);
  });

  it('refuses a cursor it never issued', async () => {
    const fetch = tableOf([row(1, 'only')]);
    const forged = encodeCursor({ createdAt: at(1), id: randomUUID() }, scope)
      .split('')
      .reverse()
      .join('');
    for (const cursor of ['not-a-cursor', forged, 'e30']) {
      const attempt = paginate({ limit: 1, cursor, scope }, fetch);
      await expect(attempt).rejects.toBeInstanceOf(InvalidCursorError);
      await expect(attempt).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
  });

  it('ends with no cursor, and answers an empty list', async () => {
    const fetch = tableOf([row(2, 'a'), row(1, 'b')]);
    expect((await paginate({ limit: 2, scope }, fetch)).page).toEqual({
      hasMore: false,
      nextCursor: null,
    });
    expect(await paginate({ limit: 2, scope }, tableOf([]))).toEqual({
      data: [],
      page: { hasMore: false, nextCursor: null },
    });
  });
});
