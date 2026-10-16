import type { StandardSchemaConverter } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * Zod 4 schemas as OpenAPI 3.1 schema objects, which are JSON Schema 2020-12
 * (ADR-0024): a request converts the side a client sends, a response the side
 * it receives. A type JSON Schema cannot describe stops generation, rather
 * than becoming an empty schema a client would send anything through
 * (docs/reference/api.md, "OpenAPI and compatibility"). A schema named with
 * `.meta({ id })` becomes a shared component; two different schemas may not
 * claim one name.
 */
export function zodSchemaConverter(): StandardSchemaConverter {
  const named = new Map<string, string>();
  return (schema, { schemaType }) => {
    if (!(schema instanceof z.ZodType)) return undefined;
    const converted = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: schemaType,
      unrepresentable: 'throw',
    });
    const { $schema: _dialect, $defs: components = {}, ...root } = converted;
    for (const [name, definition] of Object.entries(components)) {
      const text = JSON.stringify(definition);
      const earlier = named.get(name);
      if (earlier !== undefined && earlier !== text) {
        throw new Error(`Two different schemas are named ${name}`);
      }
      named.set(name, text);
    }
    return { schema: root, components };
  };
}
