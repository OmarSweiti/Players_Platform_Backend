/** An IANA time zone name, such as `Asia/Amman` (ADR-0007). */
export type TimeZone = string & { readonly __brand: 'TimeZone' };

// An offset is not a zone: it knows no daylight saving and no history.
const OFFSET = /^[+-]\d|^(?:UTC|GMT)[+-]/;

/**
 * Whether `value` names an IANA zone the runtime knows, spelled as the zone
 * database spells it. Intl also takes offsets such as `+03:00`, and any
 * casing, which is why those are refused: the database holds a tenant's zone to
 * the same rule, by its own list of names (the dates_instants_zones migration).
 */
export function isTimeZone(value: string): value is TimeZone {
  if (value.trim() !== value || OFFSET.test(value)) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  // A link such as Asia/Calcutta may resolve to another name; a mis-cased
  // name resolves to the same one, differently spelled.
  return resolved === value || resolved.toLowerCase() !== value.toLowerCase();
}

export function parseTimeZone(value: string): TimeZone {
  if (!isTimeZone(value)) throw new RangeError('not an IANA time zone');
  return value;
}
