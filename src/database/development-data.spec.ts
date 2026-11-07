import { describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_DATA,
  developmentId,
  TENANT_ROLES,
} from './development-data';

const ARABIC = /^[؀-ۿ ]+$/;
const LATIN = /^[A-Za-z ]+$/;

describe('the development data', () => {
  it('development_ids_are_rfc_9562_name_based_uuidv8', () => {
    // RFC 9562, Appendix B.2: the DNS namespace and "www.example.com".
    expect(
      developmentId('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    ).toBe('5c146b14-3c52-8afd-938a-375d0df1fbf6');
    // The values infra/keycloak/test-realm.sh holds the realm to: the seed
    // and the realm derive the same ids.
    expect(developmentId('tenant:sadara')).toBe(
      '0b8bcd4b-0465-8de0-ae58-1b5acbb6c58e',
    );
    expect(developmentId('account:coach@sadara.test')).toBe(
      '5d194e24-d795-8124-ad47-ad296eebe5d7',
    );
  });

  it('has_one_member_for_each_tenant_role_in_each_tenant', () => {
    expect(TENANT_ROLES).toHaveLength(17);
    expect(TENANT_ROLES).not.toContain('SUPER_ADMIN');
    expect(DEVELOPMENT_DATA.tenants.map((t) => t.slug)).toEqual([
      'sadara',
      'northwind',
    ]);
    for (const tenant of DEVELOPMENT_DATA.tenants) {
      const members = DEVELOPMENT_DATA.members.filter(
        (m) => m.tenantSlug === tenant.slug,
      );
      expect(members.map((m) => m.role)).toEqual(TENANT_ROLES);
      for (const member of members) {
        expect(member.email).toMatch(
          new RegExp(`^[a-z-]+@${tenant.slug}\\.test$`),
        );
        expect(member.subject).toBe(developmentId(`account:${member.email}`));
      }
    }
    const ids = [
      ...DEVELOPMENT_DATA.tenants,
      ...DEVELOPMENT_DATA.members,
      ...DEVELOPMENT_DATA.players,
    ].map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names_players_in_arabic_and_in_latin_in_each_tenant', () => {
    for (const tenant of DEVELOPMENT_DATA.tenants) {
      const names = DEVELOPMENT_DATA.players
        .filter((p) => p.tenantSlug === tenant.slug)
        .map((p) => p.fullName);
      expect(names.some((name) => ARABIC.test(name))).toBe(true);
      expect(names.some((name) => LATIN.test(name))).toBe(true);
      expect(names.every((name) => ARABIC.test(name) || LATIN.test(name))).toBe(
        true,
      );
    }
  });
});
