import type { INestApplication, Type } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import {
  DocumentBuilder,
  type OpenAPIObject,
  type OperationObject,
  type PathItemObject,
  type ReferenceObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { z } from 'zod';
import { IF_MATCH_KEY } from '../concurrency/if-match.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  type ErrorCode,
  FIELD_PROBLEMS,
  type FieldErrorCode,
  PROBLEMS,
} from '../errors/error-codes';
import { MAX_FIELD_ERRORS } from '../filters/problem-details.filter';
import { REQUEST_ID_HEADER } from '../logging/request-id';
import {
  RATE_LIMIT_KEY,
  type RateLimitMetadata,
} from '../rate-limit/rate-limit.decorator';
import { RAISES_KEY } from './responses';
import { zodSchemaConverter } from './zod-schema-converter';

/** The session cookie (ADR-0023), issued at sign-in from `0.5.6`. */
export const SESSION_COOKIE = '__Host-Http-sadara_session';
/** The header that carries the session's CSRF token on every write (ADR-0003). */
export const CSRF_HEADER = 'X-CSRF-Token';

const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;
type Method = (typeof METHODS)[number];
/** Methods that change nothing, so carry no CSRF token. */
const SAFE: ReadonlySet<Method> = new Set(['get', 'head', 'options']);

const PROBLEM_JSON = 'application/problem+json';
const ref = (name: string): ReferenceObject => ({
  $ref: `#/components/schemas/${name}`,
});

/** RFC 9457 with Sadara's extensions (docs/reference/api.md, "Problem details"). */
const ProblemDetails = z.object({
  type: z.string().describe('The problem type: urn:sadara:problem:<code>'),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string(),
  instance: z.string().describe('This occurrence: urn:uuid:<request id>'),
  code: z.enum(Object.keys(PROBLEMS) as [ErrorCode, ...ErrorCode[]]),
  message: z.string().describe("Safe to show, in the request's language"),
  requestId: z.string(),
  fieldErrors: z
    .array(
      z.object({
        field: z.string().describe('A JSON Pointer into what was sent'),
        code: z.enum(
          Object.keys(FIELD_PROBLEMS) as [FieldErrorCode, ...FieldErrorCode[]],
        ),
        message: z.string(),
      }),
    )
    .max(MAX_FIELD_ERRORS),
});

/** What the contract needs to know of a route besides its swagger metadata. */
interface RouteFacts {
  isPublic: boolean;
  rateLimited: boolean;
  ifMatch: boolean;
  raises: readonly ErrorCode[];
}

/**
 * The API contract (ADR-0010): OpenAPI 3.1, from the routes the application
 * mounts and the Zod schemas they validate with (ADR-0024). Nothing but
 * metadata is read, so `app` may be in Nest's preview mode, where no provider
 * exists and nothing connects (src/contract.ts).
 *
 * Every operation gets, from facts about its route rather than by hand:
 * - its security: none when public; the session cookie, plus the CSRF header
 *   on a write;
 * - each problem the HTTP pipeline can answer it with (problemCodesOf), and
 *   those it raises itself (`@Raises`), as problem details narrowed to the
 *   status's codes;
 * - `X-Request-Id` on every response, `Retry-After` on 429.
 *
 * Generation fails on an operation without a declared success (`@Returns`),
 * on a parameter or body without a schema, and on a problem response
 * declared any other way than through `@Raises`.
 */
export function buildContract(app: INestApplication): OpenAPIObject {
  const routes = routesOf(app);
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle('Sadara API')
    .setDescription(
      'Player management for sports agencies, in Arabic and English. ' +
        'A success is `{ data }`; a failure is an RFC 9457 problem.',
    )
    .setVersion('1')
    .addCookieAuth(
      SESSION_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        name: SESSION_COOKIE,
        description: 'The opaque session the API sets at sign-in (ADR-0023).',
      },
      'session',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: CSRF_HEADER,
        description: "The session's CSRF token, required on every write.",
      },
      'csrf',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    standardSchemaConverter: zodSchemaConverter(),
    operationIdFactory: (controller, method) => `${controller}.${method}`,
  });

  const { $schema: _dialect, ...problemDetails } = z.toJSONSchema(
    ProblemDetails,
    { target: 'draft-2020-12', io: 'output' },
  );
  const components = document.components ?? {};
  components.schemas = sortedByName({
    ...components.schemas,
    ProblemDetails: problemDetails as SchemaObject,
  });
  components.headers = {
    RequestId: {
      description: 'Names this request in logs and problem details',
      schema: { type: 'string' },
    },
    RetryAfter: {
      description: 'Seconds until the request may be tried again',
      schema: { type: 'integer', minimum: 1 },
    },
  };
  document.components = sortedByName(components);

  const paths: Record<string, PathItemObject> = {};
  for (const path of Object.keys(document.paths).sort()) {
    const item = document.paths[path];
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const facts = routes.get(operation.operationId ?? '');
      if (!facts) {
        throw new Error(`${label(method, path)} has no route to describe it`);
      }
      completeOperation(method, path, operation, facts);
    }
    paths[path] = item;
  }
  document.paths = paths;
  // What the document builder adds empty: an empty server list means "this
  // origin" anyway.
  if (document.servers?.length === 0) delete document.servers;
  if (document.tags?.length === 0) delete document.tags;
  if (Object.keys(document.info.contact ?? {}).length === 0) {
    delete document.info.contact;
  }
  return document;
}

/** The codes the HTTP pipeline can answer this operation with. */
function problemCodesOf(
  method: Method,
  path: string,
  operation: OperationObject,
  facts: RouteFacts,
): Set<ErrorCode> {
  const codes = new Set<ErrorCode>(['INTERNAL_ERROR']);
  // Paths, queries and bodies are validated; a header like If-Match is not.
  const validated = (operation.parameters ?? []).some(
    (parameter) =>
      !('$ref' in parameter) && ['path', 'query'].includes(parameter.in),
  );
  if (validated || operation.requestBody) codes.add('VALIDATION_FAILED');
  if (operation.requestBody) codes.add('PAYLOAD_TOO_LARGE');
  if (!facts.isPublic) {
    codes.add('AUTHENTICATION_REQUIRED').add('SESSION_EXPIRED');
    codes.add('FORBIDDEN');
    if (!SAFE.has(method)) codes.add('CSRF_FAILED');
  }
  if (path.includes('{')) codes.add('NOT_FOUND');
  if (facts.ifMatch) {
    codes.add('REVISION_MISMATCH').add('PRECONDITION_REQUIRED');
  }
  // The limits fail closed: without Valkey, a limited route answers 503.
  if (facts.rateLimited) {
    codes.add('RATE_LIMITED').add('DEPENDENCY_UNAVAILABLE');
  }
  for (const code of facts.raises) codes.add(code);
  return codes;
}

function completeOperation(
  method: Method,
  path: string,
  operation: OperationObject,
  facts: RouteFacts,
): void {
  const where = label(method, path);
  for (const parameter of operation.parameters ?? []) {
    if ('$ref' in parameter) continue;
    if (!hasSchema(parameter.schema)) {
      throw new Error(`${where}: parameter ${parameter.name} has no schema`);
    }
  }
  const body = operation.requestBody as RequestBodyObject | undefined;
  if (body && !Object.values(body.content).every((c) => hasSchema(c.schema))) {
    throw new Error(`${where}: its body has no schema`);
  }

  const declared = Object.entries(operation.responses);
  const successes = declared.filter(([status]) => /^2\d\d$/.test(status));
  if (
    successes.length === 0 ||
    !successes.every(([, response]) => hasContent(response))
  ) {
    throw new Error(`${where} declares no success: add @Returns(schema)`);
  }
  const problem = declared.find(([status]) => !/^2\d\d$/.test(status));
  if (problem) {
    throw new Error(`${where} declares ${problem[0]} itself: use @Raises`);
  }

  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of problemCodesOf(method, path, operation, facts)) {
    const { status } = PROBLEMS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const responses: Record<string, ResponseObject | ReferenceObject> = {};
  for (const [status, response] of successes) {
    responses[status] = withRequestId(response as ResponseObject);
  }
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const codes = byStatus.get(status) ?? [];
    responses[String(status)] = problemResponse(status, codes);
  }
  operation.responses = responses;
  operation.security = facts.isPublic
    ? []
    : [SAFE.has(method) ? { session: [] } : { session: [], csrf: [] }];
}

function problemResponse(status: number, codes: ErrorCode[]): ResponseObject {
  const response: ResponseObject = {
    description: codes.map((code) => PROBLEMS[code].title).join('; '),
    headers: {
      [REQUEST_ID_HEADER]: { $ref: '#/components/headers/RequestId' },
    },
    content: {
      [PROBLEM_JSON]: {
        schema: {
          allOf: [
            ref('ProblemDetails'),
            {
              type: 'object',
              properties: {
                status: { const: status },
                code: { enum: codes },
              } as Record<string, SchemaObject>,
            },
          ],
        },
      },
    },
  };
  if (status === 429 && response.headers) {
    response.headers['Retry-After'] = {
      $ref: '#/components/headers/RetryAfter',
    };
  }
  return response;
}

function withRequestId(response: ResponseObject): ResponseObject {
  return {
    ...response,
    headers: {
      ...response.headers,
      [REQUEST_ID_HEADER]: { $ref: '#/components/headers/RequestId' },
    },
  };
}

/** Every handler the application mounts, by the operation id it is given. */
function routesOf(app: INestApplication): Map<string, RouteFacts> {
  const reflector = new Reflector();
  const routes = new Map<string, RouteFacts>();
  const owners = new Map<string, Type>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type | null;
      if (!controller) continue;
      const owner = owners.get(controller.name);
      if (owner && owner !== controller) {
        throw new Error(`Two controllers are named ${controller.name}`);
      }
      owners.set(controller.name, controller);
      const prototype = controller.prototype as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[key];
        if (key === 'constructor' || typeof handler !== 'function') continue;
        const targets = [handler, controller];
        const limit = reflector.getAllAndOverride<RateLimitMetadata>(
          RATE_LIMIT_KEY,
          targets,
        );
        routes.set(`${controller.name}.${key}`, {
          isPublic:
            reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ===
            true,
          rateLimited: limit !== 'none',
          ifMatch: reflector.get<boolean>(IF_MATCH_KEY, handler) === true,
          raises:
            reflector.getAllAndMerge<ErrorCode[]>(RAISES_KEY, targets) ?? [],
        });
      }
    }
  }
  return routes;
}

const label = (method: Method, path: string) =>
  `${method.toUpperCase()} ${path}`;

function hasSchema(schema: SchemaObject | ReferenceObject | undefined) {
  return schema !== undefined && Object.keys(schema).length > 0;
}

function hasContent(response: ResponseObject | ReferenceObject | undefined) {
  if (!response || '$ref' in response) return false;
  return Object.values(response.content ?? {}).some((media) =>
    hasSchema(media.schema),
  );
}

/** A map with its keys in code-point order, so the file diffs stably. */
function sortedByName<T extends object>(map: T): T {
  return Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ) as T;
}
