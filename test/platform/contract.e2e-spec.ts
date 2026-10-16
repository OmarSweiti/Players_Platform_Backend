import { readFileSync } from 'node:fs';
import type {
  OpenAPIObject,
  OperationObject,
  ReferenceObject,
  ResponseObject,
  SchemaObject,
} from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { PROBLEMS, type ErrorCode } from '../../src/common/errors/error-codes';
import {
  CONTRACT_FILE,
  generateContract,
  serializeContract,
} from '../../src/contract';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

function operationsOf(contract: OpenAPIObject) {
  return Object.entries(contract.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation: OperationObject | undefined = item[method];
      return operation ? [{ where: `${method} ${path}`, path, operation }] : [];
    }),
  );
}

function isResponse(
  response: ResponseObject | ReferenceObject | undefined,
): response is ResponseObject {
  return response !== undefined && !('$ref' in response);
}

describe('the committed OpenAPI contract (0.3.9)', () => {
  it('the_committed_contract_matches_the_code', async () => {
    const committed = readFileSync(CONTRACT_FILE, 'utf8');
    expect(
      serializeContract(await generateContract()),
      `${CONTRACT_FILE} is stale: run \`npm run openapi\` and commit it`,
    ).toBe(committed);
  });

  // Read from the document alone, by rules independent of the code that
  // builds it: what any operation can meet, every operation must declare.
  it('problem_details_are_declared_for_every_operation', () => {
    const contract = JSON.parse(
      readFileSync(CONTRACT_FILE, 'utf8'),
    ) as OpenAPIObject;
    const operations = operationsOf(contract);
    expect(operations.length).toBeGreaterThan(0);

    for (const { where, path, operation } of operations) {
      const responses = Object.entries(operation.responses);
      const successes = responses.filter(([status]) => status.startsWith('2'));
      expect(successes.length, `${where} declares a success`).toBeGreaterThan(
        0,
      );
      for (const [status, response] of successes) {
        expect(isResponse(response), `${where} ${status}`).toBe(true);
        const schema = (response as ResponseObject).content?.[
          'application/json'
        ]?.schema as SchemaObject | undefined;
        expect(schema?.required, `${where} ${status} is { data }`).toContain(
          'data',
        );
      }

      const problems = responses.filter(([status]) => !status.startsWith('2'));
      const statuses = problems.map(([status]) => status);
      expect(statuses, `${where} can always fail`).toContain('500');
      if ((operation.security ?? []).length > 0) {
        expect(statuses, `${where} needs a session`).toContain('401');
      }
      if (path.includes('{')) {
        expect(statuses, `${where} names a resource`).toContain('404');
      }
      for (const [status, response] of problems) {
        expect(isResponse(response), `${where} ${status}`).toBe(true);
        const schema = (response as ResponseObject).content?.[
          'application/problem+json'
        ]?.schema as SchemaObject | undefined;
        expect(schema?.allOf?.[0], `${where} ${status}`).toEqual({
          $ref: '#/components/schemas/ProblemDetails',
        });
        const codes = (
          (schema?.allOf?.[1] as SchemaObject).properties?.code as
            SchemaObject | undefined
        )?.enum as ErrorCode[] | undefined;
        expect(
          codes?.length,
          `${where} ${status} names its codes`,
        ).toBeGreaterThan(0);
        for (const code of codes ?? []) {
          expect(PROBLEMS[code].status, `${where}: ${code}`).toBe(
            Number(status),
          );
        }
      }
    }
  });
});
