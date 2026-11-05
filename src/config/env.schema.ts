import type { ConfigModuleOptions } from '@nestjs/config';
import { z } from 'zod';

// Every variable the API reads, validated once at boot. A secret has no
// default: the API refuses to start without it, rather than run on a value
// anyone could guess. This schema is where later settings — identity,
// sessions, storage — join. Every variable is described in .env.example.

const port = z.coerce.number().int().min(1).max(65535);
// Exactly `true` or `false`: a typo refuses to boot rather than guess.
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
// A proxy the API believes about the client's address: an address, a subnet,
// or one of Express's names for a range.
const proxy = z.union([
  z.ipv4(),
  z.ipv6(),
  z.cidrv4(),
  z.cidrv6(),
  z.enum(['loopback', 'linklocal', 'uniquelocal']),
]);

// A host as a tenant's is stored and as a browser sends it, lower case
// (0.4.10): DNS labels of letters, digits and inner hyphens, dot-separated.
const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
export const DNS_LABEL = new RegExp(`^${LABEL}$`);
export const HOST_NAME = new RegExp(`^(?=.{1,253}$)(${LABEL}\\.)*${LABEL}$`);
// An optional setting left empty (`NAME=` in .env) is unset, not a value.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional(),
  );
const hostList = z
  .string()
  .default('')
  .transform((list) =>
    list
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .pipe(z.array(z.string().regex(HOST_NAME, 'lower-case host names')));

// The API connects as the runtime role only (0.4.2): never as the role that
// owns the schema, the one that migrates it, or the image's superuser.
const PRIVILEGED_ROLES = new Set([
  'sadara_owner',
  'sadara_migrator',
  'postgres',
]);
// The role a URL connects as; '' when it is no URL, which z.url reports itself
// (a refinement still runs after a failed check).
function roleOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
}
const database = z
  .url({ protocol: /^postgres(ql)?$/ })
  .refine((url) => !PRIVILEGED_ROLES.has(roleOf(url)), {
    message:
      'must connect as the runtime role, never as the owner, the migrator or a superuser',
  });

// The identity provider's issuer (0.5.4): HTTPS, or plain HTTP on this machine
// only (the local stack's Keycloak), without a query or fragment.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const issuer = z.url({ protocol: /^https?$/ }).refine(
  (url) => {
    const { protocol, hostname, search, hash } = new URL(url);
    return (
      (protocol === 'https:' || LOOPBACK.has(hostname)) &&
      search === '' &&
      hash === ''
    );
  },
  { message: 'must be an HTTPS URL, or HTTP on localhost, with no query' },
);
const clientId = z.string().regex(/^[a-z0-9-]+$/, 'a client id');

/** Where the API's routes live; the committed contract names this one. */
export const DEFAULT_API_PREFIX = 'api';

export const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
    PORT: port.default(3000),
    API_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and hyphens')
      .default(DEFAULT_API_PREFIX),
    DATABASE_URL: database,
    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: port.default(6379),
    // The proxies whose X-Forwarded-For names the client (0.3.8), comma-
    // separated. None by default: the client is whoever connected.
    TRUSTED_PROXIES: z
      .string()
      .default('')
      .transform((list) =>
        list
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ''),
      )
      .pipe(z.array(proxy)),
    // The web app's origin: CORS allows it, and links in emails point to it.
    CORS_ORIGIN: z.url({ protocol: /^https?$/ }),
    // Before sign-in the tenant is the host's (0.5.2): an exact tenant domain,
    // else {slug}.APEX_DOMAIN. Unset: only exact domains resolve.
    APEX_DOMAIN: optional(
      z.string().regex(HOST_NAME, 'a lower-case host name'),
    ),
    // The single-agency launch: the hosts, comma-separated, that belong to the
    // tenant DEFAULT_TENANT_SLUG. Both set, or neither; every other host that
    // names no tenant is refused.
    DEFAULT_TENANT_SLUG: optional(
      z.string().regex(DNS_LABEL, 'a lower-case DNS label'),
    ),
    DEFAULT_TENANT_HOSTS: hostList,
    // The identity provider (0.5.4; ADR-0002), found from its issuer by OIDC
    // discovery. The API signs people in as OIDC_CLIENT_ID, and manages their
    // accounts as OIDC_ADMIN_CLIENT_ID, a service account that may manage
    // users and nothing else. Both secrets are required, with no default.
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: z.string().min(16),
    OIDC_ADMIN_CLIENT_ID: clientId,
    OIDC_ADMIN_CLIENT_SECRET: z.string().min(16),
    MAIL_FROM: z.email(),
    // Unfinished modules (0.1.8): off unless set, and their routes answer 404.
    FEATURE_MEDICAL: flag.default(false),
    FEATURE_SCOUTING: flag.default(false),
  })
  .superRefine((env, issues) => {
    const hosts = env.DEFAULT_TENANT_HOSTS.length > 0;
    if (hosts !== (env.DEFAULT_TENANT_SLUG !== undefined)) {
      issues.addIssue({
        code: 'custom',
        path: [hosts ? 'DEFAULT_TENANT_SLUG' : 'DEFAULT_TENANT_HOSTS'],
        message: 'must be set together with the other',
      });
    }
  });
export type Env = z.infer<typeof Env>;

/** What is wrong with one variable, in words that never repeat its value. */
function problemOf(
  issue: z.core.$ZodIssue,
  raw: Record<string, unknown>,
): string {
  const name = String(issue.path[0] ?? 'the environment');
  const value = raw[name];
  if (value === undefined || value === '') return `${name} is missing`;
  switch (issue.code) {
    case 'invalid_value':
      return `${name} must be one of ${issue.values.join(', ')}`;
    case 'too_small':
      return issue.origin === 'string'
        ? `${name} must be at least ${issue.minimum} characters`
        : `${name} must be at least ${issue.minimum}`;
    case 'too_big':
      return `${name} must be at most ${issue.maximum}`;
    case 'invalid_format': // a pattern says what it wants; a format names itself
      return issue.format === 'regex'
        ? `${name} must be ${issue.message}`
        : `${name} must be a valid ${issue.format}`;
    case 'invalid_type':
      return `${name} must be a ${issue.expected}`;
    case 'custom': // a refinement's message, written above, never the value
      return `${name} ${issue.message}`;
    default:
      return `${name} is invalid`;
  }
}

/**
 * The validated environment, or an error naming every variable that is
 * missing or invalid — never a value, so the error can be logged.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = Env.safeParse(raw);
  if (result.success) return result.data;
  const problems = [
    ...new Set(result.error.issues.map((issue) => problemOf(issue, raw))),
  ];
  throw new Error(
    `The environment is invalid: ${problems.join('; ')}. Every variable is described in .env.example.`,
  );
}

/** How the application loads its configuration: validated, once, at boot. */
export const configOptions: ConfigModuleOptions = {
  isGlobal: true,
  validate: parseEnv,
};
