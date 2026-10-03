import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setupSwagger } from './swagger';

@Module({})
class EmptyModule {}

describe('setupSwagger', () => {
  it('swagger_is_served_only_in_development', async () => {
    for (const nodeEnv of [
      'development',
      'test',
      'staging',
      'production',
    ] as const) {
      const app = await NestFactory.create(EmptyModule, { logger: false });
      setupSwagger(app, nodeEnv);
      await app.init();
      const server = app.getHttpServer() as Parameters<typeof request>[0];

      const response = await request(server).get('/docs-json');

      expect([nodeEnv, response.status]).toEqual([
        nodeEnv,
        nodeEnv === 'development' ? 200 : 404,
      ]);
      await app.close();
    }
  });
});
