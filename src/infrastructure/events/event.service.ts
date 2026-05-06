import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';

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
   * Queue notification for async processing
   */
  async queueNotification(data: any) {
    await this.notificationQueue.add('send-notification', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });
  }

  /**
   * Queue audit log for async processing
   */
  async queueAuditLog(data: any) {
    await this.auditLogQueue.add('create-audit-log', data, {
      removeOnComplete: true,
    });
  }
}
