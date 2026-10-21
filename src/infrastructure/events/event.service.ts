import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { jobCorrelation } from '../logging/correlation';

@Injectable()
export class EventService {
  constructor(
    @InjectQueue('notifications') private notificationQueue: Queue,
    @InjectQueue('audit-logs') private auditLogQueue: Queue,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Emit domain events for internal listeners
   */
  emit(event: string, payload: any) {
    this.eventEmitter.emit(event, payload);
  }

  /**
   * Queue notification for async processing, correlated with the request
   * that caused it (infrastructure/logging/correlation.ts)
   */
  async queueNotification(data: any) {
    const correlated = { ...(data as object), correlation: jobCorrelation() };
    await this.notificationQueue.add('send-notification', correlated, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });
  }

  /**
   * Queue audit log for async processing, correlated with the request that
   * caused it
   */
  async queueAuditLog(data: any) {
    const correlated = { ...(data as object), correlation: jobCorrelation() };
    await this.auditLogQueue.add('create-audit-log', correlated, {
      removeOnComplete: true,
    });
  }
}
