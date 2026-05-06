import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  tenantId: string;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly asyncLocalStorage = new AsyncLocalStorage<TenantContext>();

  constructor() {
    super({});
  }

  async onModuleInit() {
    await this.$connect();
    
    // Add middleware for automatic tenant isolation
    // Note: $use is available on PrismaClient but TypeScript may not recognize it in extended classes
    (this as any).$use(async (params: any, next: any) => {
      const context = this.asyncLocalStorage.getStore();
      
      // Only apply tenant filtering if we have a tenant context
      // and the model has a tenantId field
      if (context?.tenantId && params.model) {
        const modelHasTenantId = await this.hasTenantIdField(params.model);
        
        if (modelHasTenantId) {
          // Inject tenantId into where clause
          if (params.action === 'findUnique' || params.action === 'findFirst') {
            params.args.where = {
              ...params.args.where,
              tenantId: context.tenantId,
            };
          } else if (params.action === 'findMany') {
            params.args.where = {
              ...params.args.where,
              tenantId: context.tenantId,
            };
          } else if (params.action === 'create') {
            params.args.data = {
              ...params.args.data,
              tenantId: context.tenantId,
            };
          } else if (params.action === 'update') {
            params.args.where = {
              ...params.args.where,
              tenantId: context.tenantId,
            };
          } else if (params.action === 'delete') {
            params.args.where = {
              ...params.args.where,
              tenantId: context.tenantId,
            };
          } else if (params.action === 'count') {
            params.args.where = {
              ...params.args.where,
              tenantId: context.tenantId,
            };
          }
        }
      }
      
      return next(params);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run a database operation with tenant context
   */
  async runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.asyncLocalStorage.run({ tenantId }, fn);
  }

  /**
   * Get current tenant ID from context
   */
  getCurrentTenantId(): string | undefined {
    return this.asyncLocalStorage.getStore()?.tenantId;
  }

  /**
   * Check if a model has a tenantId field
   */
  private async hasTenantIdField(model: string): Promise<boolean> {
    const modelsWithTenantId = [
      'User',
      'Player',
      'Season',
      'Training',
      'TrainingSession',
      'Contract',
      'ContractVersion',
      'ContractApproval',
      'LegalTicket',
      'LegalNote',
      'Conversation',
      'ConversationMember',
      'Message',
      'Notification',
      'AuditLog',
      'Document',
      'PlayerMedia',
      'MedicalRecord',
      'PerformanceRecord',
      'Rating',
      'Enrollment',
      'Attendance',
    ];
    
    return modelsWithTenantId.includes(model);
  }
}
