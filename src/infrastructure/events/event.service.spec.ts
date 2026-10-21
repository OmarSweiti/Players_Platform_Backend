import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { runWithRequestId } from '../logging/correlation';
import { EventService } from './event.service';

const REQUEST = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f5a6';

describe('EventService', () => {
  it('correlates the jobs it queues with the request that caused them', async () => {
    const queued: unknown[] = [];
    const queue = {
      add: (_name: string, data: unknown) => {
        queued.push(data);
        return Promise.resolve();
      },
    } as unknown as Queue;
    const events = new EventService(queue, queue, new EventEmitter2());

    await runWithRequestId(REQUEST, async () => {
      await events.queueNotification({ kind: 'invitation' });
      await events.queueAuditLog({ action: 'member.invited' });
    });

    expect(queued).toEqual([
      { kind: 'invitation', correlation: { requestId: REQUEST } },
      { action: 'member.invited', correlation: { requestId: REQUEST } },
    ]);
  });
});
