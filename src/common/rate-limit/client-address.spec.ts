import { describe, expect, it } from 'vitest';
import { clientAddressOf } from './client-address';

describe('clientAddressOf', () => {
  it('takes an IPv4 address as it is, also when seen through IPv6', () => {
    expect(clientAddressOf('203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressOf('::FFFF:127.0.0.1')).toBe('127.0.0.1');
  });

  it.each([
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3:8d3::/64'],
    ['2001:DB8:85A3:08D3::1', '2001:db8:85a3:8d3::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    // `::` standing for a single group, and a group after it within the /64
    ['2001:db8::7:6:5:4:3', '2001:db8:0:7::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
  ])('counts IPv6 %s as its /64, %s', (ip, block) => {
    expect(clientAddressOf(ip)).toBe(block);
  });

  it('gives every address in a /64 the same allowance', () => {
    expect(clientAddressOf('2001:db8:1:2:aaaa::1')).toBe(
      clientAddressOf('2001:db8:1:2:ffff:ffff:ffff:ffff'),
    );
    expect(clientAddressOf('2001:db8:1:2::1')).not.toBe(
      clientAddressOf('2001:db8:1:3::1'),
    );
  });

  it('counts what is not an address as one unknown client', () => {
    expect(clientAddressOf(undefined)).toBe('unknown');
    expect(clientAddressOf('not-an-address')).toBe('unknown');
    expect(clientAddressOf('::ffff:999.1.1.1')).toBe('unknown');
  });
});
