import { describe, expect, it } from 'vitest';
import { databaseConnectionOf } from './database-url';

describe('databaseConnectionOf', () => {
  it('moves the schema from the URL to the adapter', () => {
    expect(
      databaseConnectionOf(
        'postgresql://app:pw@127.0.0.1:5432/sadara_test?schema=sadara_test_ab12cd34ef56',
      ),
    ).toEqual({
      connectionString: 'postgresql://app:pw@127.0.0.1:5432/sadara_test',
      schema: 'sadara_test_ab12cd34ef56',
    });
  });

  it('keeps the other parameters and names no schema when the URL has none', () => {
    expect(
      databaseConnectionOf(
        'postgresql://app:pw@127.0.0.1:5432/sadara?sslmode=disable',
      ),
    ).toEqual({
      connectionString:
        'postgresql://app:pw@127.0.0.1:5432/sadara?sslmode=disable',
      schema: undefined,
    });
  });

  it('refuses a schema that is not a plain identifier', () => {
    expect(() =>
      databaseConnectionOf(
        'postgresql://app:pw@127.0.0.1:5432/sadara?schema=public%22%3B%20drop',
      ),
    ).toThrow(/plain lowercase PostgreSQL identifier/);
  });
});
