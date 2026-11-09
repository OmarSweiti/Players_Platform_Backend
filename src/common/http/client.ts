import type { Request } from 'express';
import type { TenantClient } from '../tenancy/tenant-context';

/**
 * The request's client: its address as the trusted proxies report it, and its
 * user agent — values to record, never to decide by. The session guard puts it
 * in the context (0.7.2); sign-in and back-channel logout, which have none,
 * give it to their security events (0.7.3).
 */
export function clientOf(request: Request): TenantClient {
  const userAgent = request.header('user-agent');
  return {
    ...(request.ip === undefined ? {} : { address: request.ip }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}
