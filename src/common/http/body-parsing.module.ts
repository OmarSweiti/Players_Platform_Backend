import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import express from 'express';

/**
 * Request bodies, parsed as module middleware, with the parsers and limits
 * Nest would mount itself (JSON, and URL-encoded forms). Nest's own are off
 * (APP_OPTIONS, app.setup.ts): it mounts them before any module's middleware,
 * so a body it refused, malformed or too large, never reached the access log.
 * A global module's middleware runs first, and the access log's (nestjs-pino)
 * is a global module's, so every request is logged before its body is read.
 */
@Module({})
export class BodyParsingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(express.json(), express.urlencoded({ extended: true }))
      .forRoutes({ path: '{/*splat}', method: RequestMethod.ALL });
  }
}
