// The ASCII spaces an address can arrive wrapped in: space, tab, CR and LF.
const EDGE_SPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

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
  return email.normalize('NFKC').replace(EDGE_SPACE, '').toLowerCase();
}
