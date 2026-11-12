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
// The worker's discovery connection (0.7.6): the registry role, which reads
// tenant_directory's id and is_active and nothing else.
const registryDatabase = z
  .url({ protocol: /^postgres(ql)?$/ })
  .refine((url) => roleOf(url) === 'sadara_registry', {
    message: 'must connect as the registry role, sadara_registry',
  });
const nodeEnv = z.enum(['development', 'test', 'staging', 'production']);
const redisHost = z.string().min(1).default('localhost');
const redisPort = port.default(6379);

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
// The object store's endpoint (0.8.1): the same rule, and no path — the
// bucket is its own setting.
const storeEndpoint = issuer.refine((url) => new URL(url).pathname === '/', {
  message: 'must have no path: the bucket is S3_BUCKET',
});
// A bucket's name as S3 allows it: lower case, digits, dots and hyphens.
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const clientId = z.string().regex(/^[a-z0-9-]+$/, 'a client id');
// The store's bucket and the key that reaches it (0.8.1): the API's and the
// worker's alike (0.8.4).
const STORE = {
  S3_REGION: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/, 'a region name')
    .default('us-east-1'),
  S3_BUCKET: z.string().regex(BUCKET, 'an S3 bucket name'),
  S3_ACCESS_KEY_ID: z.string().min(3),
  S3_SECRET_ACCESS_KEY: z.string().min(16),
  S3_FORCE_PATH_STYLE: flag.default(false),
};
// The worker reaches the store by its service's name inside the stack
// (http://objectstore:7070): HTTP is refused outside development and test.
const workerStoreEndpoint = z.url({ protocol: /^https?$/ }).refine(
  (url) => {
    const { pathname, search, hash } = new URL(url);
    return pathname === '/' && search === '' && hash === '';
  },
  { message: 'must have no path or query: the bucket is S3_BUCKET' },
);

/** Where the API's routes live; the committed contract names this one. */
export const DEFAULT_API_PREFIX = 'api';

export const Env = z
  .object({
    NODE_ENV: nodeEnv,
    PORT: port.default(3000),
    API_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and hyphens')
      .default(DEFAULT_API_PREFIX),
    DATABASE_URL: database,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
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
    // The key the session's CSRF token is derived under (0.5.6; ADR-0003): an
    // HMAC of the session token's digest, so nothing is stored. Rotating it:
    // the new key here, the old one in CSRF_SECRET_PREVIOUS until every
    // session it served has expired (12 hours).
    CSRF_SECRET: z.string().min(32),
    CSRF_SECRET_PREVIOUS: optional(z.string().min(32)),
    // The key a security event's network data is hashed under (0.7.3): an
    // HMAC of the client's address, so that one address is recognised across
    // events and none is stored. A key of its own, apart from CSRF_SECRET's,
    // so that rotating either never touches the other; rotating it starts a
    // new series of hashes, which no longer match the old ones.
    SECURITY_EVENT_KEY: z.string().min(32),
    // Private, versioned object storage (0.8.1; ADR-0009, ADR-0020): an
    // S3-compatible endpoint — locally the stack's Versity gateway — its
    // bucket, and an access key with no default. Path-style addressing
    // (/bucket/key), which a gateway on one host needs; a provider that
    // wants virtual hosts sets it false.
    S3_ENDPOINT: storeEndpoint,
    // Where a browser reaches the store, when not at S3_ENDPOINT (0.8.3): the
    // links the API hands out are signed for it — locally the proxy's
    // https://storage.localhost — while the API's own calls go to S3_ENDPOINT.
    // Unset: links name S3_ENDPOINT.
    S3_PUBLIC_ENDPOINT: optional(storeEndpoint),
    ...STORE,
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
  return parseWith(Env, raw);
}

/** `raw` through `schema`, or an error naming every variable, never a value. */
function parseWith<T extends z.ZodType>(
  schema: T,
  raw: Record<string, unknown>,
): z.output<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const problems = [
    ...new Set(result.error.issues.map((issue) => problemOf(issue, raw))),
  ];
  throw new Error(
    `The environment is invalid: ${problems.join('; ')}. Every variable is described in .env.example.`,
  );
}

/**
 * What the tenant provisioning command needs besides the API's own settings
 * (0.5.9): the provisioning service account, which may change the sign-in
 * client and nothing else. Only that command reads these; the API never
 * holds them.
 */
const Provisioner = z.object({
  OIDC_PROVISIONER_CLIENT_ID: clientId,
  OIDC_PROVISIONER_CLIENT_SECRET: z.string().min(16),
});
export type ProvisioningEnv = Env & z.infer<typeof Provisioner>;

/** The provisioning command's environment: the API's, and the provisioner's. */
export function parseProvisioningEnv(
  raw: Record<string, unknown>,
): ProvisioningEnv {
  return parseCommandEnv(Provisioner, raw);
}

/**
 * What the security-event import needs besides the API's own settings
 * (0.7.3): the event reader's service account, which may read the realm's
 * login and admin events and nothing else. Only that command reads these;
 * the API never holds them.
 */
const EventReader = z.object({
  OIDC_EVENTS_CLIENT_ID: clientId,
  OIDC_EVENTS_CLIENT_SECRET: z.string().min(16),
});
export type EventImportEnv = Env & z.infer<typeof EventReader>;

/** The security-event import's environment: the API's, and the reader's. */
export function parseEventImportEnv(
  raw: Record<string, unknown>,
): EventImportEnv {
  return parseCommandEnv(EventReader, raw);
}

/**
 * A command's environment: the API's settings and the command's own, or an
 * error naming every problem with either, never a value.
 */
function parseCommandEnv<T extends z.ZodType<object>>(
  own: T,
  raw: Record<string, unknown>,
): Env & z.output<T> {
  const problems: string[] = [];
  const attempt = <R>(parse: () => R): R | undefined => {
    try {
      return parse();
    } catch (error) {
      problems.push((error as Error).message);
      return undefined;
    }
  };
  const env = attempt(() => parseEnv(raw));
  const command = attempt(() => parseWith(own, raw));
  if (!env || !command) throw new Error(problems.join(' '));
  return { ...env, ...command };
}

/** How the application loads its configuration: validated, once, at boot. */
export const configOptions: ConfigModuleOptions = {
  isGlobal: true,
  validate: parseEnv,
};

/**
 * What the worker reads (0.7.6), and nothing else: the runtime role's database
 * for the tenant transactions it works in, the registry role's for finding the
 * active tenants, Valkey for its queue, the SMTP server (0.7.8), and the
 * object store and the malware scanner its scans use (0.8.4). It holds none
 * of the API's identity-provider or session secrets.
 */
export const WorkerEnv = z
  .object({
    NODE_ENV: nodeEnv,
    DATABASE_URL: database,
    REGISTRY_DATABASE_URL: registryDatabase,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    // A file the worker touches after every pass of its relay: its container's
    // health check reads its age. Unset, nothing is written.
    WORKER_HEARTBEAT_FILE: optional(z.string().min(1)),
    // The least severe line it writes; unset, NODE_ENV's (debug in development,
    // which logs every query of a pass that runs every second).
    LOG_LEVEL: optional(
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    ),
    // Outgoing email (0.7.8): the SMTP server, Mailpit locally (the production
    // provider is 1.6.3's). SMTP_TLS: `implicit` from the first byte (465),
    // `starttls` required after connecting (587), or `none` — on this machine's
    // Mailpit only, never in staging or production. The account, if the server
    // asks for one, with both its parts.
    SMTP_HOST: z.string().regex(HOST_NAME, 'a lower-case host name'),
    SMTP_PORT: port,
    SMTP_TLS: z.enum(['implicit', 'starttls', 'none']),
    SMTP_USERNAME: optional(z.string().min(1)),
    SMTP_PASSWORD: optional(z.string().min(16)),
    // The sender address of outgoing email.
    MAIL_FROM: z.email(),
    // The object store (0.8.4): the scan reads a file's pinned version from
    // it and promotes a clean one inside it. The API's bucket and key.
    S3_ENDPOINT: workerStoreEndpoint,
    ...STORE,
    // The malware scanner (0.8.4): ClamAV's daemon, the stack's `clamav`.
    CLAMAV_HOST: z.string().min(1),
    CLAMAV_PORT: port.default(3310),
    // Where an email's links point: a tenant's own domain, else
    // {slug}.APEX_DOMAIN, as the API resolves a host to its tenant (0.5.2).
    APEX_DOMAIN: z.string().regex(HOST_NAME, 'a lower-case host name'),
  })
  .superRefine((env, issues) => {
    if (
      env.SMTP_TLS === 'none' &&
      ['staging', 'production'].includes(env.NODE_ENV)
    ) {
      issues.addIssue({
        code: 'custom',
        path: ['SMTP_TLS'],
        message: 'must encrypt outside development and test',
      });
    }
    if (
      new URL(env.S3_ENDPOINT).protocol === 'http:' &&
      ['staging', 'production'].includes(env.NODE_ENV)
    ) {
      issues.addIssue({
        code: 'custom',
        path: ['S3_ENDPOINT'],
        message: 'must be HTTPS outside development and test',
      });
    }
    if (
      (env.SMTP_USERNAME === undefined) !==
      (env.SMTP_PASSWORD === undefined)
    ) {
      issues.addIssue({
        code: 'custom',
        path: [
          env.SMTP_USERNAME === undefined ? 'SMTP_USERNAME' : 'SMTP_PASSWORD',
        ],
        message: 'must be set together with the other',
      });
    }
  });
export type WorkerEnv = z.infer<typeof WorkerEnv>;

/** The worker's environment, or an error naming every variable, never a value. */
export function parseWorkerEnv(raw: Record<string, unknown>): WorkerEnv {
  return parseWith(WorkerEnv, raw);
}
