import type { FieldIssue } from './domain-error';
import { type FieldErrorCode, isFieldErrorCode } from './error-codes';

/**
 * A Standard Schema issue (https://standardschema.dev) as a validation pipe
 * hands it over. Zod 4's issues also carry `code`, `keys` and `params`; none
 * carries the value it rejected.
 */
interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

// Zod 4's issue codes, as field codes.
const FIELD_CODE_OF = new Map<string, FieldErrorCode>([
  ['invalid_type', 'INVALID_TYPE'],
  ['invalid_format', 'INVALID_FORMAT'],
  ['invalid_value', 'INVALID_VALUE'],
  ['too_small', 'TOO_SMALL'],
  ['too_big', 'TOO_BIG'],
  ['not_multiple_of', 'INVALID_VALUE'],
  ['invalid_union', 'INVALID_VALUE'],
  ['invalid_key', 'INVALID_VALUE'],
  ['invalid_element', 'INVALID_VALUE'],
]);

/** A JSON Pointer (RFC 6901) to a field: `/players/0/name`; '' is the whole input. */
export function pointerTo(path: readonly PropertyKey[]): string {
  return path
    .map((key) => `/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/** The fields a failed schema names, and what is wrong with each. */
export function fieldIssuesOf(issues: readonly SchemaIssue[]): FieldIssue[] {
  return issues.flatMap((issue) => {
    const path = (issue.path ?? []).map((segment) =>
      typeof segment === 'object' ? segment.key : segment,
    );
    const { code, keys, params } = issue as SchemaIssue & {
      code?: unknown;
      keys?: unknown;
      params?: unknown;
    };
    if (code === 'unrecognized_keys' && Array.isArray(keys)) {
      return keys.map((key: unknown) => ({
        field: pointerTo([...path, String(key)]),
        code: 'UNKNOWN_FIELD' as const,
      }));
    }
    return [
      {
        field: pointerTo(path),
        code: fieldCodeOf(code, params, issue.message),
      },
    ];
  });
}

function fieldCodeOf(
  code: unknown,
  params: unknown,
  message: string,
): FieldErrorCode {
  // A refinement may name its field code: `{ params: { code: 'OUT_OF_RANGE' } }`.
  if (code === 'custom') {
    const own = (params as { code?: unknown } | undefined)?.code;
    return typeof own === 'string' && isFieldErrorCode(own)
      ? own
      : 'INVALID_VALUE';
  }
  // Zod reports a missing value as a type error, naming what it received;
  // schema-issues.spec.ts pins that wording.
  if (code === 'invalid_type' && message.endsWith('received undefined')) {
    return 'REQUIRED';
  }
  return (
    (typeof code === 'string' && FIELD_CODE_OF.get(code)) || 'INVALID_VALUE'
  );
}
