import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { growingEnum } from './growing-enum';
import { zodSchemaConverter } from './zod-schema-converter';

describe('a growing enum', () => {
  it('is described as x-extensible-enum, and still takes only its values', () => {
    const schema = z.strictObject({
      grown: growingEnum(z.enum(['b', 'a'])),
      fixed: z.enum(['b', 'a']),
    });
    const converted = zodSchemaConverter()(schema, { schemaType: 'output' });
    const properties = (
      converted?.schema as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;
    // Its values, in their order, but no closed list a new one would break.
    expect(properties.grown).toEqual({
      type: 'string',
      'x-extensible-enum': ['b', 'a'],
    });
    // An enum not marked keeps its closed list.
    expect(properties.fixed).toEqual({ type: 'string', enum: ['b', 'a'] });
    // Only the contract changes: the server still answers these values alone.
    expect(schema.safeParse({ grown: 'c', fixed: 'a' }).success).toBe(false);
    expect(schema.safeParse({ grown: 'a', fixed: 'a' }).success).toBe(true);
  });
});
