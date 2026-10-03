import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { describeError } from '../logging/describe-error';
import { routeTemplateOf } from '../logging/route-template';

// An access log line holds the method, the route template, the status, the
// duration and the tenant of the verified session — nothing the client sent:
// no URL, header, body or address. Structured logs replace this in 0.10.1.
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { tenantId?: string }>();
    const response = context.switchToHttp().getResponse<Response>();

    const method = request.method;
    const route = routeTemplateOf(request);
    const tenantId = request.tenantId ?? 'N/A'; // TenantGuard sets it from the session

    const now = Date.now();
    const requestId = this.generateRequestId();

    // Log incoming request
    this.logger.log(`[${requestId}] ${method} ${route} | Tenant: ${tenantId}`);

    return next.handle().pipe(
      tap(() => {
        const statusCode = response.statusCode;
        const responseTime = Date.now() - now;

        // Log successful response
        this.logger.log(
          `[${requestId}] ${method} ${route} - ${statusCode} - ${responseTime}ms`,
        );

        // Warn on slow requests (>1000ms)
        if (responseTime > 1000) {
          this.logger.warn(
            `[${requestId}] SLOW REQUEST: ${method} ${route} took ${responseTime}ms`,
          );
        }
      }),
      catchError((error: unknown) => {
        const responseTime = Date.now() - now;
        const status = (error as { status?: unknown }).status;
        const statusCode = typeof status === 'number' ? status : 500;

        // The class only: the exception filter logs an unhandled error's frames
        this.logger.error(
          `[${requestId}] ${method} ${route} - ${statusCode} - ${responseTime}ms | ${describeError(error)}`,
        );

        throw error;
      }),
    );
  }

  private generateRequestId(): string {
    return (
      Math.random().toString(36).substring(2, 15) + Date.now().toString(36)
    );
  }
}
