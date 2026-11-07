import { createHash } from 'node:crypto';
import {
  type FootPreference,
  type Locale,
  type PlayerPosition,
  UserRole,
} from '@prisma/client';
import { type CivilDate, parseCivilDate } from '../common/time/civil-date';
import { parseTimeZone, type TimeZone } from '../common/time/time-zone';
import { normalizeEmail } from '../modules/users/domain/email';

/**
 * The synthetic development data (0.5.11): two fictional tenants, one member
 * for each tenant role in each, and players with Arabic and Latin names.
 * Everything is invented, and every address is on the reserved `.test`
 * domain (RFC 6761). It grows as the phases add what a tenant holds.
 *
 * The members' accounts are in the development realm
 * (infra/keycloak/realm-sadara.json in the umbrella): the same addresses,
 * with ids derived by the same rule, so a membership is linked to its account
 * through the account's id, never through its address.
 */

/** The namespace every development id is derived in, the realm's included. */
export const DEVELOPMENT_NAMESPACE = 'b17a1124-e87a-42a1-8686-85b091391c55';

/**
 * The id of the development record `name` (`tenant:sadara`,
 * `account:coach@sadara.test`): RFC 9562's name-based UUIDv8, SHA-256 (its
 * Appendix B.2). The same on every machine and in every run, so a seeded
 * database can be named in a document or a test.
 */
export function developmentId(
  name: string,
  namespace: string = DEVELOPMENT_NAMESPACE,
): string {
  const bytes = createHash('sha256')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // the RFC 9562 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export interface DevelopmentTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly defaultLocale: Locale;
  readonly timezone: TimeZone;
  readonly defaultCurrency: string;
}

export interface DevelopmentMember {
  readonly id: string;
  readonly tenantSlug: string;
  readonly role: UserRole;
  readonly email: string;
  readonly normalizedEmail: string;
  readonly firstName: string;
  readonly lastName: string;
  /** The account's id at the development identity provider: its subject. */
  readonly subject: string;
}

export interface DevelopmentPlayer {
  readonly id: string;
  readonly tenantSlug: string;
  readonly fullName: string;
  readonly dateOfBirth: CivilDate;
  readonly position: PlayerPosition;
  readonly footPreference: FootPreference;
  readonly jerseyNumber: number;
}

export interface DevelopmentData {
  readonly tenants: readonly DevelopmentTenant[];
  readonly members: readonly DevelopmentMember[];
  readonly players: readonly DevelopmentPlayer[];
}

/**
 * The tenant roles: every role but the platform's `SUPER_ADMIN`, which no
 * tenant holds and the seed never makes.
 */
export const TENANT_ROLES: readonly UserRole[] = Object.values(UserRole).filter(
  (role) => role !== UserRole.SUPER_ADMIN,
);

const TENANTS = [
  {
    slug: 'sadara',
    name: 'وكالة صدارة الرياضية',
    surname: 'Sadara',
    defaultLocale: 'ar',
    timezone: 'Asia/Amman',
    defaultCurrency: 'JOD',
  },
  {
    slug: 'northwind',
    name: 'Northwind Sports Agency',
    surname: 'Northwind',
    defaultLocale: 'en',
    timezone: 'Europe/London',
    defaultCurrency: 'GBP',
  },
] as const;

type PlayerRow = readonly [
  fullName: string,
  dateOfBirth: string,
  position: PlayerPosition,
  footPreference: FootPreference,
  jerseyNumber: number,
];

/** Invented names, in Arabic script and in Latin, in each tenant. */
const PLAYERS: Record<(typeof TENANTS)[number]['slug'], readonly PlayerRow[]> =
  {
    sadara: [
      ['ليث الحسيني', '2003-04-17', 'GK', 'RIGHT', 1],
      ['يزن الخطيب', '2001-09-02', 'CB', 'LEFT', 4],
      ['كريم النجار', '2005-01-23', 'CM', 'BOTH', 8],
      ['Tomas Varga', '2000-11-30', 'RW', 'LEFT', 7],
      ['Noah Brennick', '2009-06-14', 'ST', 'RIGHT', 9],
    ],
    northwind: [
      ['Liam Hartley', '2002-03-08', 'GK', 'RIGHT', 1],
      ['Mateo Silvan', '2004-12-19', 'LB', 'LEFT', 3],
      ['Oscar Lindqvist', '1999-07-25', 'CAM', 'RIGHT', 10],
      ['سامي الربيعي', '2006-02-11', 'CDM', 'RIGHT', 6],
      ['عمر الزعبي', '2009-10-05', 'LW', 'BOTH', 11],
    ],
  };

/** `SPORTING_DIRECTOR` → `sporting-director`, the address's local part. */
function localPartOf(role: UserRole): string {
  return role.toLowerCase().replaceAll('_', '-');
}

/** `SPORTING_DIRECTOR` → `Sporting Director`. */
function titleOf(role: UserRole): string {
  return localPartOf(role)
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/** The development data, as the seed writes it. */
export const DEVELOPMENT_DATA: DevelopmentData = {
  tenants: TENANTS.map((tenant) => ({
    id: developmentId(`tenant:${tenant.slug}`),
    slug: tenant.slug,
    name: tenant.name,
    defaultLocale: tenant.defaultLocale,
    timezone: parseTimeZone(tenant.timezone),
    defaultCurrency: tenant.defaultCurrency,
  })),
  members: TENANTS.flatMap((tenant) =>
    TENANT_ROLES.map((role) => {
      const email = `${localPartOf(role)}@${tenant.slug}.test`;
      return {
        id: developmentId(`member:${email}`),
        tenantSlug: tenant.slug,
        role,
        email,
        normalizedEmail: normalizeEmail(email),
        firstName: titleOf(role),
        lastName: tenant.surname,
        subject: developmentId(`account:${email}`),
      };
    }),
  ),
  players: TENANTS.flatMap((tenant) =>
    PLAYERS[tenant.slug].map(
      ([fullName, dateOfBirth, position, footPreference, jerseyNumber], i) => ({
        id: developmentId(`player:${tenant.slug}:${i + 1}`),
        tenantSlug: tenant.slug,
        fullName,
        dateOfBirth: parseCivilDate(dateOfBirth),
        position,
        footPreference,
        jerseyNumber,
      }),
    ),
  ),
};
