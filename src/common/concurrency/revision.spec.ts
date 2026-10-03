import { describe, expect, it } from 'vitest';
import {
  assertChanged,
  etagOf,
  PreconditionRequiredError,
  RevisionMismatchError,
  revisionToChange,
} from './revision';

const player = { id: '6f1c2a9e-4b7d-4c1e-9a3f-2d5e8b7c6a10', revision: 3 };

describe('entity tags and revisions', () => {
  it('gives one tag per kind, id, revision and projection', () => {
    const tag = etagOf('player', player, 'full');
    expect(tag).toMatch(/^"[\w-]{43}"$/); // strong: no W/ prefix
    expect(etagOf('player', player, 'full')).toBe(tag);
    for (const other of [
      etagOf('contract', player, 'full'),
      etagOf('player', { ...player, revision: 4 }, 'full'),
      etagOf('player', player, 'without-medical'),
    ]) {
      expect(other).not.toBe(tag);
    }
  });

  it('lets an edit through only from the tag it would be served now', () => {
    const etag = etagOf('player', player, 'full');
    expect(revisionToChange(etag, { etag, revision: 3 })).toBe(3);
    expect(revisionToChange(` ${etag} `, { etag, revision: 3 })).toBe(3);

    for (const missing of [undefined, '', '  ']) {
      expect(() => revisionToChange(missing, { etag, revision: 3 })).toThrow(
        PreconditionRequiredError,
      );
    }
    const stale = etagOf('player', { ...player, revision: 2 }, 'full');
    for (const refused of [stale, `W/${etag}`, '*', `${etag}, ${stale}`]) {
      expect(() => revisionToChange(refused, { etag, revision: 3 })).toThrow(
        RevisionMismatchError,
      );
    }
  });

  it('reads no changed row as another edit having won', () => {
    expect(() => assertChanged(1)).not.toThrow();
    expect(() => assertChanged(0)).toThrow(RevisionMismatchError);
  });
});
