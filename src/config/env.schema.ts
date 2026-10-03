import type { ConfigModuleOptions } from '@nestjs/config';
import { z } from 'zod';

// Every variable the API reads, validated once at boot. A secret has no
// default: the API refuses to start without it, rather than run on a value
// anyone could guess. This schema is where later settings — identity,
// sessions, storage — join. Every variable is described in .env.example.

const secret = z.string().min(32);
const port = z.coerce.number().int().min(1).max(65535);
// Exactly `true` or `false`: a typo refuses to boot rather than guess.
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  PORT: port.default(3000),
  API_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('api'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  JWT_SECRET: secret,
  JWT_EXPIRES_IN: z.string().min(1).default('15m'),
  JWT_REFRESH_SECRET: secret,
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: port.default(6379),
  // The web app's origin: CORS allows it, and links in emails point to it.
  CORS_ORIGIN: z.url({ protocol: /^https?$/ }),
  MAIL_FROM: z.email(),
  // Unfinished modules (0.1.8): off unless set, and their routes answer 404.
  FEATURE_MEDICAL: flag.default(false),
  FEATURE_SCOUTING: flag.default(false),
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
    case 'invalid_format':
      return `${name} must be a valid ${issue.format}`;
    case 'invalid_type':
      return `${name} must be a ${issue.expected}`;
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
