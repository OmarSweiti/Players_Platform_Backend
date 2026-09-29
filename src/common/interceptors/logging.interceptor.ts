import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const method = request.method;
    const url = request.url;
    const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
    const tenantId =
      request.headers['x-tenant-id'] || request.tenantId || 'N/A';

    const now = Date.now();
    const requestId = this.generateRequestId();

    // Log incoming request
    this.logger.log(
      `[${requestId}] ${method} ${url} | IP: ${ip} | Tenant: ${tenantId}`,
    );

    return next.handle().pipe(
      tap(() => {
        const statusCode = response.statusCode;
        const responseTime = Date.now() - now;

        // Log successful response
        this.logger.log(
          `[${requestId}] ${method} ${url} - ${statusCode} - ${responseTime}ms`,
        );

        // Warn on slow requests (>1000ms)
        if (responseTime > 1000) {
          this.logger.warn(
            `[${requestId}] SLOW REQUEST: ${method} ${url} took ${responseTime}ms`,
          );
        }
      }),
      catchError((error) => {
        const responseTime = Date.now() - now;
        const statusCode = error.status || 500;

        // Log error with stack trace
        this.logger.error(
          `[${requestId}] ${method} ${url} - ${statusCode} - ${responseTime}ms | Error: ${error.message}`,
          error.stack,
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
