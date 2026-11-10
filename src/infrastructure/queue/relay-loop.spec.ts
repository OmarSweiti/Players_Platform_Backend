import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RelayLoop } from './relay-loop';

// The relay's loop (0.7.6): pass after pass, one at a time; a failed pass
// does not stop it; the heartbeat is touched after each; stop waits.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the relay loop', () => {
  it('turns_pass_after_pass_and_survives_a_failed_one', async () => {
    let passes = 0;
    let concurrent = 0;
    let most = 0;
    const relay = {
      relayOnce: async () => {
        passes += 1;
        concurrent += 1;
        most = Math.max(most, concurrent);
        await wait(5);
        concurrent -= 1;
        if (passes === 2) throw new TypeError('the database is not migrated');
        return { tenants: 0, claimed: 0, published: 0 };
      },
    };
    const heartbeat = join(mkdtempSync(join(tmpdir(), 'relay-')), 'alive');
    const loop = new RelayLoop(relay, 10, heartbeat);
    loop.start();
    await wait(120);
    await loop.stop();
    const after = passes;
    await wait(60);
    // Several passes, the second failing, never two at once; none after stop.
    expect(after).toBeGreaterThanOrEqual(3);
    expect(most).toBe(1);
    expect(passes).toBe(after);
    expect(Number(readFileSync(heartbeat, 'utf8'))).toBeGreaterThan(0);
  });

  it('stop_waits_for_the_pass_under_way', async () => {
    let finished = false;
    const loop = new RelayLoop(
      {
        relayOnce: async () => {
          await wait(80);
          finished = true;
          return { tenants: 0, claimed: 0, published: 0 };
        },
      },
      1_000,
    );
    loop.start();
    await wait(20);
    await loop.stop();
    expect(finished).toBe(true);
  });
});
