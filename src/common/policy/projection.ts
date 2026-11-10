import { z } from 'zod';
import {
  ACCESS_AUDITED_CLASSES,
  type ConfidentialClass,
} from './confidential-class';

// Confidential projections (0.6.4; I-2, SR-ACL-008). A response is built on
// the server from its schema, an allowlist: only the fields the schema names
// leave, so a widened select or a row passed whole reaches nobody, and a
// confidential field leaves only for a member its class is disclosed to
// (`disclosedClasses`, policy.ts). The use case projects, not the route, so
// the rule holds for every caller. The markers are the code's own, and the
// tests do not trust them: test/authz/confidential-fields.e2e-spec.ts checks
// every response against an independent classification
// (test/fixtures/field-classification.ts).
//
// A field of an access-audited class (0.7.4; I-5) leaves only through
// `projectAndRecord`, whose one caller is the access audit
// (src/infrastructure/audit/access-audit.ts): the access is recorded, in the
// caller's transaction, before the value is returned. `project` refuses to
// release one.

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

/**
 * A response that would release a field of an access-audited class without
 * its access event: a programming error, refused before anything leaves.
 */
export class UnauditedRelease extends Error {
  constructor(
    readonly path: string,
    readonly confidentialClass: ConfidentialClass,
  ) {
    super(
      `The response at "${path}" would release ${confidentialClass} without an access event: release it through the access audit.`,
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
  const { projected, carried } = projectCarrying(schema, value, disclosed);
  const audited = [...carried].find(([, cls]) =>
    ACCESS_AUDITED_CLASSES.includes(cls),
  );
  if (audited) throw new UnauditedRelease(...audited);
  return projected;
}

/**
 * The response, as `project` builds it, released only once `recordAccess`
 * has recorded the access-audited classes it carries (0.7.4; I-5): their
 * names, in the order of CONFIDENTIAL_CLASSES. A response that carries none
 * records nothing. A recording that fails rejects, and the value is never
 * returned: the data is withheld. The access audit is its one caller, which
 * records in the caller's transaction.
 */
export async function projectAndRecord<V>(
  schema: z.ZodType,
  value: V,
  disclosed: ReadonlySet<ConfidentialClass>,
  recordAccess: (classes: readonly ConfidentialClass[]) => Promise<void>,
): Promise<V> {
  const { projected, carried } = projectCarrying(schema, value, disclosed);
  const present = new Set([...carried].map(([, cls]) => cls));
  const classes = ACCESS_AUDITED_CLASSES.filter((cls) => present.has(cls));
  if (classes.length > 0) await recordAccess(classes);
  return projected;
}

/** The projection, and every confidential field it carries: where, and its class. */
function projectCarrying<V>(
  schema: z.ZodType,
  value: V,
  disclosed: ReadonlySet<ConfidentialClass>,
): { projected: V; carried: Map<string, ConfidentialClass> } {
  const carried = new Map<string, ConfidentialClass>();
  const projected = walk(schema, value, disclosed, '', carried);
  return {
    projected: (projected === WITHHELD ? undefined : projected) as V,
    carried,
  };
}

function walk(
  schema: z.core.$ZodType,
  value: unknown,
  disclosed: ReadonlySet<ConfidentialClass>,
  path: string,
  carried: Map<string, ConfidentialClass>,
): unknown {
  const marker = markers.get(schema);
  if (marker && !disclosed.has(marker.confidential)) return WITHHELD;
  // A field of a disclosed class leaves, null or not: its being there is
  // what it says.
  if (marker && value !== undefined) {
    carried.set(path || '(root)', marker.confidential);
  }
  // Through every wrapper before the value is looked at: a marker inside
  // `.nullable()` withholds a null too.
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly
  ) {
    return walk(schema.unwrap(), value, disclosed, path, carried);
  }
  if (value === null || value === undefined) return value;
  if (schema instanceof z.ZodArray) {
    if (!Array.isArray(value)) return WITHHELD;
    return value.map((item: unknown) =>
      walk(schema.element, item, disclosed, `${path}[]`, carried),
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
        carried,
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
