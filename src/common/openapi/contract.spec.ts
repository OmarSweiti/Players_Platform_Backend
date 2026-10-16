import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ApiResponse,
  type OpenAPIObject,
  type OperationObject,
  type ParameterObject,
  type ReferenceObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
} from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configureRoutes } from '../../app.setup';
import { IfMatch } from '../concurrency/if-match.decorator';
import { Public } from '../decorators/public.decorator';
import { behindFeature } from '../feature-flags/feature-gate.guard';
import { IdParams, day } from '../validation/schemas';
import { buildContract, CSRF_HEADER } from './contract';
import { Raises, Returns, ReturnsPage } from './responses';

const Thing = z
  .object({ id: z.uuid(), name: z.string(), bornOn: day })
  .meta({ id: 'FixtureThing' });
const ThingPatch = z.strictObject({ name: z.string().min(1).max(100) });
const ThingQuery = z.strictObject({ name: z.string().max(100).optional() });

@Controller('things')
class ThingsController {
  @Public()
  @Get()
  @ReturnsPage(Thing)
  list(@Query({ schema: ThingQuery }) _query: unknown) {
    return [];
  }

  @Get(':id')
  @Returns(Thing)
  read(@Param({ schema: IdParams }) _params: IdParams) {
    return null;
  }

  @Patch(':id')
  @Returns(Thing)
  @Raises('INVALID_TRANSITION')
  rename(
    @Param({ schema: IdParams }) _params: IdParams,
    @IfMatch() _ifMatch: string | undefined,
    @Body({ schema: ThingPatch }) _patch: unknown,
  ) {
    return null;
  }
}

@Controller('quarantined')
class QuarantinedController {
  @Get()
  @Returns(z.null())
  ping() {
    return null;
  }
}
behindFeature('medical', [QuarantinedController]);

/** The contract of a module of these controllers, as the application builds its own. */
async function contractOf(...controllers: Type[]): Promise<OpenAPIObject> {
  @Module({ controllers })
  class FixtureModule {}
  const app = await NestFactory.create(FixtureModule, {
    preview: true,
    logger: false,
  });
  try {
    configureRoutes(app, 'api');
    return buildContract(app);
  } finally {
    await app.close();
  }
}

function operation(
  contract: OpenAPIObject,
  method: 'get' | 'patch' | 'post',
  path: string,
): OperationObject {
  const found = contract.paths[path]?.[method];
  if (!found) throw new Error(`no ${method} ${path} in the contract`);
  return found;
}

/** The codes a problem response narrows ProblemDetails to. */
function codesOf(response: ResponseObject | ReferenceObject | undefined) {
  if (!response || '$ref' in response) return undefined;
  const schema = response.content?.['application/problem+json']?.schema as
    SchemaObject | undefined;
  const narrowed = schema?.allOf?.[1] as SchemaObject | undefined;
  return (narrowed?.properties?.code as SchemaObject | undefined)?.enum;
}

describe('the API contract', () => {
  it('a_public_operation_declares_no_security', async () => {
    const contract = await contractOf(ThingsController);
    const list = operation(contract, 'get', '/api/v1/things');
    expect(list.security).toEqual([]);
    expect(list.responses['401']).toBeUndefined();
  });

  it('a_read_requires_the_session_and_a_write_the_csrf_header_too', async () => {
    const contract = await contractOf(ThingsController);
    expect(operation(contract, 'get', '/api/v1/things/{id}').security).toEqual([
      { session: [] },
    ]);
    const rename = operation(contract, 'patch', '/api/v1/things/{id}');
    expect(rename.security).toEqual([{ session: [], csrf: [] }]);
    expect(codesOf(rename.responses['403'])).toEqual([
      'FORBIDDEN',
      'CSRF_FAILED',
    ]);
    expect(contract.components?.securitySchemes?.csrf).toMatchObject({
      in: 'header',
      name: CSRF_HEADER,
    });
  });

  it('an_edit_declares_if_match_and_its_revision_problems', async () => {
    const rename = operation(
      await contractOf(ThingsController),
      'patch',
      '/api/v1/things/{id}',
    );
    const header = (rename.parameters as ParameterObject[]).find(
      (parameter) => parameter.in === 'header',
    );
    expect(header).toMatchObject({ name: 'If-Match', required: true });
    expect(codesOf(rename.responses['412'])).toEqual(['REVISION_MISMATCH']);
    expect(codesOf(rename.responses['428'])).toEqual(['PRECONDITION_REQUIRED']);
    // What the route raises itself, beside what the pipeline adds.
    expect(codesOf(rename.responses['409'])).toEqual(['INVALID_TRANSITION']);
  });

  it('request_and_response_schemas_come_from_the_zod_schemas', async () => {
    const contract = await contractOf(ThingsController);
    const rename = operation(contract, 'patch', '/api/v1/things/{id}');
    const body = rename.requestBody as RequestBodyObject;
    expect(body.content['application/json']?.schema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
      additionalProperties: false,
    });
    const id = (rename.parameters as ParameterObject[]).find(
      (parameter) => parameter.in === 'path',
    );
    expect(id?.schema).toMatchObject({ type: 'string', format: 'uuid' });
    // A day is a civil date, never a midnight instant (docs/reference/api.md).
    expect(contract.components?.schemas?.FixtureThing).toMatchObject({
      properties: { bornOn: { type: 'string', format: 'date' } },
    });
    expect(codesOf(rename.responses['400'])).toEqual(['VALIDATION_FAILED']);
  });

  it('a_list_answers_one_page_of_its_items', async () => {
    const list = operation(
      await contractOf(ThingsController),
      'get',
      '/api/v1/things',
    );
    const ok = list.responses['200'] as ResponseObject;
    expect(ok.content?.['application/json']?.schema).toMatchObject({
      properties: {
        data: {
          type: 'array',
          items: { $ref: '#/components/schemas/FixtureThing' },
        },
        page: {
          properties: {
            nextCursor: { type: ['string', 'null'] },
            hasMore: { type: 'boolean' },
          },
        },
      },
      required: ['data', 'page'],
    });
  });

  it('quarantined_modules_stay_out_of_the_contract', async () => {
    const contract = await contractOf(ThingsController, QuarantinedController);
    expect(Object.keys(contract.paths)).toEqual([
      '/api/v1/things',
      '/api/v1/things/{id}',
    ]);
  });

  it('generation_refuses_an_operation_without_a_declared_success', async () => {
    @Controller('silent')
    class SilentController {
      @Post()
      create() {
        return null;
      }
    }
    await expect(contractOf(SilentController)).rejects.toThrow(
      'POST /api/v1/silent declares no success: add @Returns(schema)',
    );
  });

  it('a_problem_is_declared_only_through_raises', async () => {
    @Controller('loose')
    class LooseController {
      @Get()
      @Returns(z.null())
      @ApiResponse({ status: 404, description: 'Not found' })
      read() {
        return null;
      }
    }
    await expect(contractOf(LooseController)).rejects.toThrow(
      'GET /api/v1/loose declares 404 itself: use @Raises',
    );
  });
});
