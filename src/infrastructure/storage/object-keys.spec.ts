import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jobContext } from '../queue/job-context';
import {
  assertObjectKey,
  newObjectKey,
  ObjectKeyRefused,
  objectKeyOf,
} from './object-keys';
import { attachmentNamed } from './s3-storage';

/** A tenant's context, as a job is given one: the job loader is a minter. */
const contextOf = (tenantId: string) =>
  jobContext(tenantId, 'object-keys-spec');

describe('object keys', () => {
  it('are the context tenant’s, in their area, random, and read back only as made', () => {
    const ctx = contextOf(randomUUID());
    const key = newObjectKey(ctx, 'quarantine');
    expect(key).toMatch(
      new RegExp(`^tenants/${ctx.tenantId}/quarantine/[0-9a-f-]{36}$`),
    );
    expect(newObjectKey(ctx, 'quarantine')).not.toBe(key);
    expect(objectKeyOf(ctx, key, 'quarantine')).toBe(key);
    expect(() => assertObjectKey(key)).not.toThrow();

    const other = contextOf(randomUUID());
    for (const [reader, value, area] of [
      [other, key, 'quarantine'],
      [ctx, key, 'objects'],
      [ctx, `${key}.pdf`, 'quarantine'],
      [ctx, key.toUpperCase(), 'quarantine'],
      [ctx, key.replace(/[0-9a-f-]{36}$/, 'invoice'), 'quarantine'],
    ] as const) {
      expect(() => objectKeyOf(reader, value, area)).toThrow(ObjectKeyRefused);
    }
    expect(() => assertObjectKey('../../etc/passwd')).toThrow(ObjectKeyRefused);
  });
});

describe('a download’s name', () => {
  it('is an attachment, with an ASCII fallback and the name in UTF-8', () => {
    expect(attachmentNamed('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    const arabic = attachmentNamed('تقرير "الفحص" (1).pdf');
    // The fallback holds nothing that could end its quotes.
    expect(arabic).toMatch(/^attachment; filename="[\x20-\x7e]*"; /);
    expect(arabic).not.toMatch(/filename="[^"]*"[^;]*"/);
    expect(arabic).toContain(
      `filename*=UTF-8''${encodeURIComponent('تقرير "الفحص" ')}%281%29.pdf`,
    );
  });
});
