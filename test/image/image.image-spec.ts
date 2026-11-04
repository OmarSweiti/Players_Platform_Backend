import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// The production image (0.2.6), as scripts/smoke-start.sh starts it: beside a
// throwaway PostgreSQL and Valkey, from the Dockerfile, with no setting but the
// environment's. The script hands this file the container; each request is
// made inside it, so no port needs publishing.
const container = process.env.SMOKE_CONTAINER;

const inside = (...command: string[]) =>
  execFileSync('docker', ['exec', container!, ...command], {
    encoding: 'utf8',
  }).trim();

/** A GET to the API, from inside its container: the status and the body. */
function get(path: string): { status: number; body: unknown } {
  const answer = inside(
    'node',
    '-e',
    `fetch("http://127.0.0.1:3000${path}").then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.json() })))`,
  );
  return JSON.parse(answer) as { status: number; body: unknown };
}

describe('the production image', () => {
  it('the_built_image_answers_liveness', () => {
    expect(container, 'run it through scripts/smoke-start.sh').toBeTruthy();

    expect(get('/health/live')).toEqual({
      status: 200,
      body: { data: { status: 'live' } },
    });
    // It reached its database, as the runtime role, and Valkey.
    expect(get('/health/ready')).toMatchObject({ status: 200 });

    // As the base image's unprivileged user, which cannot rewrite the code.
    expect(inside('id', '-u')).toBe('1000');
    expect(() => inside('touch', 'dist/main.js')).toThrow();
  });
});
