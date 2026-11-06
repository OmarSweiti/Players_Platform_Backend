// The ASCII spaces an address can arrive wrapped in: space, tab, CR and LF.
const EDGE_SPACE = new Set([' ', '\t', '\r', '\n']);

/**
 * `value` without those spaces at either end, as PostgreSQL's
 * `btrim(value, E' \t\r\n')` leaves it. A scan from each end, in linear time
 * whatever the input: an anchored regular expression would backtrack over
 * every run of spaces inside it, and an address reaches this from a request
 * and from an identity provider's claim.
 */
function trimEdgeSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && EDGE_SPACE.has(value[start])) start += 1;
  while (end > start && EDGE_SPACE.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/**
 * The form a member's address is unique in, within a tenant (0.4.9; DB-10):
 * Unicode NFKC, without surrounding spaces, in lower case. The database holds
 * every row to the same rule (users_normalized_email_check:
 * `lower(btrim(normalize(email, NFKC), E' \t\r\n'))`), so an address written
 * any other way is refused there too.
 *
 * Email is contact data: it never links an identity (0.5.3).
 */
export function normalizeEmail(email: string): string {
  return trimEdgeSpace(email.normalize('NFKC')).toLowerCase();
}
