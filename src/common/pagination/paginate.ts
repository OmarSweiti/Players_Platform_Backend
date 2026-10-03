import {
  type CursorScope,
  decodeCursor,
  encodeCursor,
  type Keyset,
} from './cursor';

/** A collection, as every list endpoint answers one (docs/reference/api.md). */
export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

export interface PageQuery {
  limit: number;
  cursor?: string;
  scope: CursorScope;
}

/** What a list's fetch receives: how many rows, and after which. */
export interface KeysetArgs {
  take: number;
  after?: Keyset;
}

/**
 * One page of a list ordered by `(createdAt DESC, id DESC)`. `fetch` returns
 * at most `take` rows after `after` (see keysetWhere); one row more than the
 * page tells whether another page follows, and the page's last row becomes
 * the next cursor. Rows inserted meanwhile never shift a later page.
 */
export async function paginate<T extends Keyset>(
  query: PageQuery,
  fetch: (args: KeysetArgs) => Promise<T[]>,
): Promise<Page<T>> {
  const after = query.cursor
    ? decodeCursor(query.cursor, query.scope)
    : undefined;
  const rows = await fetch({ take: query.limit + 1, after });
  const hasMore = rows.length > query.limit;
  const data = rows.slice(0, query.limit);
  const last = data.at(-1);
  return {
    data,
    page: {
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last, query.scope) : null,
    },
  };
}
