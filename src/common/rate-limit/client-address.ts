import { isIPv4, isIPv6 } from 'node:net';

/**
 * Who an anonymous request counts as: the address Express resolved
 * (`request.ip`), which believes `X-Forwarded-For` only from the proxies that
 * TRUSTED_PROXIES names. An IPv4 address seen through an IPv6 socket is the
 * IPv4 address. An IPv6 client is its /64, the block one host is given: each
 * of its addresses alone would be a fresh allowance.
 */
export function clientAddressOf(ip: string | undefined): string {
  if (ip === undefined) return 'unknown'; // the socket is already gone
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (isIPv4(ip)) return ip;
  const address = ip.replace(/%.*$/, ''); // a zone: fe80::1%en0
  if (!isIPv6(address)) return 'unknown';
  return `${groupsOf(address).slice(0, 4).join(':')}::/64`;
}

/** The eight groups of a valid IPv6 address, in hexadecimal, without zeros in front. */
function groupsOf(address: string): string[] {
  const [head, tail] = address.split('::');
  const left = partsOf(head);
  const right = partsOf(tail);
  // `::` stands for as many zero groups as the address leaves out.
  const elided =
    tail === undefined ? [] : Array<string>(8 - left.length - right.length);
  return [...left, ...elided.fill('0'), ...right];
}

function partsOf(text: string | undefined): string[] {
  if (!text) return [];
  return text.split(':').flatMap((part) => {
    if (!part.includes('.')) return [parseInt(part, 16).toString(16)];
    // A trailing IPv4 address fills the last two groups.
    const [a, b, c, d] = part.split('.').map(Number);
    return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
  });
}
