import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Param, Patch, Res } from '@nestjs/common';
import type { Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IfMatch } from '../../src/common/concurrency/if-match.decorator';
import {
  assertChanged,
  etagOf,
  revisionToChange,
} from '../../src/common/concurrency/revision';
import { Public } from '../../src/common/decorators/public.decorator';
import { NotFoundError } from '../../src/common/errors/domain-error';
import { IdParams, line } from '../../src/common/validation/schemas';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bootApp, type BootedApp } from '../harness/app';
import { runPrisma } from '../harness/fixtures';

// The fixture aggregate: a table of this run's schema only, editable the way
// every domain aggregate is — `revision` from 1, a compare-and-update.
const FIXTURE_TABLE = `
  CREATE TABLE concurrency_fixture (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    revision integer NOT NULL DEFAULT 1
  )`;

interface FixtureRow {
  id: string;
  tenantId: string;
  name: string;
  revision: number;
}

/** Holds each arriving edit until `parties` have arrived (or 5 s pass). */
function barrierOf(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const everyone = new Promise<void>((resolve) => (release = resolve));
  return {
    arrive: () => {
      arrived += 1;
      if (arrived === parties) release();
      return Promise.race([
        everyone,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    },
    arrivals: () => arrived,
  };
}

let barrier: ReturnType<typeof barrierOf> | undefined;

const Rename = z.strictObject({ name: line(100) });

// Test-only routes over the fixture, built as a domain route is.
@Public()
@Controller('probe/fixtures')
class FixtureController {
  constructor(private readonly prisma: PrismaService) {}

  private async load(id: string): Promise<FixtureRow> {
    const [row] = await this.prisma.$queryRaw<FixtureRow[]>`
      SELECT id, tenant_id AS "tenantId", name, revision
      FROM concurrency_fixture WHERE id = ${id}::uuid`;
    if (!row) throw new NotFoundError('No such fixture');
    return row;
  }

  private served(row: FixtureRow, response: Response) {
    response.setHeader('ETag', etagOf('fixture', row, 'full'));
    return { id: row.id, name: row.name, revision: row.revision };
  }

  @Get(':id')
  async read(
    @Param({ schema: IdParams }) { id }: IdParams,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.served(await this.load(id), response);
  }

  @Patch(':id')
  async rename(
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: Rename }) { name }: z.infer<typeof Rename>,
    @IfMatch() ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const current = await this.load(id);
    const revision = revisionToChange(ifMatch, {
      etag: etagOf('fixture', current, 'full'),
      revision: current.revision,
    });
    await barrier?.arrive();
    const changed = await this.prisma.$executeRaw`
      UPDATE concurrency_fixture
      SET name = ${name}, revision = revision + 1
      WHERE id = ${id}::uuid AND tenant_id = ${current.tenantId}::uuid
        AND revision = ${revision}`;
    assertChanged(changed);
    return this.served(await this.load(id), response);
  }
}

describe('optimistic concurrency', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    await runPrisma().$executeRawUnsafe(FIXTURE_TABLE);
    booted = await bootApp({ controllers: [FixtureController] });
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  async function newFixture(): Promise<{ path: string; etag: string }> {
    const id = randomUUID();
    await runPrisma().$executeRaw`
      INSERT INTO concurrency_fixture (id, tenant_id, name)
      VALUES (${id}::uuid, ${randomUUID()}::uuid, 'Original')`;
    const path = `/api/v1/probe/fixtures/${id}`;
    const read = await booted.http.get(path);
    expect(read.status).toBe(200);
    return { path, etag: read.headers.etag };
  }

  it('a_stale_if_match_is_refused_with_412', async () => {
    const { path, etag } = await newFixture();
    const first = await booted.http
      .patch(path)
      .set('If-Match', etag)
      .send({ name: 'First' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ data: { name: 'First', revision: 2 } });
    expect(first.headers.etag).not.toBe(etag);

    // The tag of revision 1 no longer lets anyone edit.
    const stale = await booted.http
      .patch(path)
      .set('If-Match', etag)
      .send({ name: 'Second' });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ code: 'REVISION_MISMATCH' });
    for (const form of ['*', `W/${first.headers.etag}`]) {
      const refused = await booted.http
        .patch(path)
        .set('If-Match', form)
        .send({ name: 'Third' });
      expect([form, refused.status]).toEqual([form, 412]);
    }
    const read = await booted.http.get(path);
    expect(read.body).toMatchObject({ data: { name: 'First', revision: 2 } });
  });

  it('a_missing_if_match_is_refused_with_428', async () => {
    const { path } = await newFixture();
    const response = await booted.http.patch(path).send({ name: 'Blind' });
    expect(response.status).toBe(428);
    expect(response.body).toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    expect((await booted.http.get(path)).body).toMatchObject({
      data: { name: 'Original', revision: 1 },
    });
  });

  it('two_concurrent_edits_produce_one_winner', async () => {
    const { path, etag } = await newFixture();
    // Both edits pass the If-Match check before either updates: only the
    // compare-and-update can tell them apart.
    barrier = barrierOf(2);
    try {
      const results = await Promise.all(
        ['Left', 'Right'].map((name) =>
          booted.http.patch(path).set('If-Match', etag).send({ name }),
        ),
      );
      expect(barrier.arrivals()).toBe(2); // the race really was run
      expect(results.map(({ status }) => status).sort()).toEqual([200, 412]);
      const winner = results.find(({ status }) => status === 200)!;
      const read = await booted.http.get(path);
      expect(read.body).toEqual(winner.body);
      expect(read.body).toMatchObject({ data: { revision: 2 } });
    } finally {
      barrier = undefined;
    }
  });
});
