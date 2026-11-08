import { z } from 'zod';
import type { ConfidentialClass } from './confidential-class';

// Confidential projections (0.6.4; I-2, SR-ACL-008). A response is built on
// the server from its schema, an allowlist: only the fields the schema names
// leave, so a widened select or a row passed whole reaches nobody, and a
// confidential field leaves only for a member its class is disclosed to
// (`disclosedClasses`, policy.ts). The use case projects, not the route, so
// the rule holds for every caller. The markers are the code's own, and the
// tests do not trust them: test/authz/confidential-fields.e2e-spec.ts checks
// every response against an independent classification
// (test/fixtures/field-classification.ts).

const markers = z.registry<{ readonly confidential: ConfidentialClass }>();

/**
 * A confidential field of a response schema: the code's confidentiality
 * marker. `project` carries it only when its class is disclosed; otherwise
 * the field is absent — never null, never a placeholder — so it is optional
 * in the schema, and in the contract. It marks an object's field: a list's
 * items are not withheld one by one.
 */
export function confidential<T extends z.ZodType>(
  confidentialClass: ConfidentialClass,
  field: T,
): z.ZodOptional<T> {
  // A new schema, so the one it wraps — `id`, shared by every response —
  // stays unmarked.
  const marked = field.optional();
  markers.add(marked, { confidential: confidentialClass });
  return marked;
}

/** A response value that is neither what its schema describes nor a scalar: an object under a scalar's schema, a union's. */
export class UnprojectableResponse extends Error {
  constructor(readonly path: string) {
    super(
      `The response at "${path || '(root)'}" holds an object its schema does not describe field by field: project() cannot allowlist it.`,
    );
    this.name = new.target.name;
  }
}

/** What `walk` answers for a field that does not leave. */
const WITHHELD = Symbol('withheld');

/**
 * The response `schema` describes, built from what the use case loaded:
 * only the fields the schema names — whatever else `value` holds stays
 * behind — and a confidential field only when its class is in `disclosed`.
 * A value that does not have its schema's shape does not leave either: a
 * list where the schema wants an object, or the reverse. Scalars, `Date`
 * among them, leave as they are, for the response's serialisation.
 *
 * The value comes back with its own type: the use case's view declares its
 * confidential fields optional, and nothing the schema does not name.
 */
export function project<V>(
  schema: z.ZodType,
  value: V,
  disclosed: ReadonlySet<ConfidentialClass>,
): V {
  const projected = walk(schema, value, disclosed, '');
  return (projected === WITHHELD ? undefined : projected) as V;
}

function walk(
  schema: z.core.$ZodType,
  value: unknown,
  disclosed: ReadonlySet<ConfidentialClass>,
  path: string,
): unknown {
  const marker = markers.get(schema);
  if (marker && !disclosed.has(marker.confidential)) return WITHHELD;
  // Through every wrapper before the value is looked at: a marker inside
  // `.nullable()` withholds a null too.
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly
  ) {
    return walk(schema.unwrap(), value, disclosed, path);
  }
  if (value === null || value === undefined) return value;
  if (schema instanceof z.ZodArray) {
    if (!Array.isArray(value)) return WITHHELD;
    return value.map((item: unknown) =>
      walk(schema.element, item, disclosed, `${path}[]`),
    );
  }
  if (schema instanceof z.ZodObject) {
    if (typeof value !== 'object' || Array.isArray(value)) return WITHHELD;
    const source = value as Record<string, unknown>;
    const built: Record<string, unknown> = {};
    const shape: z.ZodRawShape = schema.shape;
    for (const [key, field] of Object.entries(shape)) {
      if (!Object.hasOwn(source, key)) continue;
      const projected = walk(
        field,
        source[key],
        disclosed,
        path ? `${path}.${key}` : key,
      );
      if (projected !== WITHHELD) built[key] = projected;
    }
    return built;
  }
  // A scalar's schema. An object here would leave unexamined: refused.
  if (typeof value === 'object' && !(value instanceof Date)) {
    throw new UnprojectableResponse(path);
  }
  return value;
}
