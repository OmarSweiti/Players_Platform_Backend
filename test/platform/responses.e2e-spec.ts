import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CurrentUser } from '../../src/common/decorators/current-user.decorator';
import { NotFoundError } from '../../src/common/errors/domain-error';
import {
  TenantTransactions,
  type TenantTx,
} from '../../src/common/tenancy/tenant-transaction';
import { IdParams } from '../../src/common/validation/schemas';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { bootApp, type BootedApp } from '../harness/app';
import { createMember, createTenant, testContext } from '../harness/fixtures';
import { signedInAs } from '../harness/session';
import { RequirePermission } from '../../src/common/decorators/permissions.decorator';

// The medical and scouting modules switched on before AppModule loads, so
// their not-found answers are checked too.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

const NewPlayer = z.strictObject({ fullName: z.string().trim().min(1) });
type NewPlayer = z.infer<typeof NewPlayer>;
const PLAYER = { id: true, fullName: true, createdAt: true, updatedAt: true };

// Test-only routes, served through the real pipeline (test/harness/app.ts):
// stored rows, which is what an envelope has to wrap, written and read as the
// member's tenant, as a rebuilt module does (0.4.3). The quarantined modules
// write without a tenant transaction, which row-level security (0.4.5)
// refuses, until each is rebuilt on one.
@Controller('probe/players')
class PlayersProbeController {
  constructor(private readonly tenants: TenantTransactions) {}

  private as<T>(member: User, work: (tx: TenantTx) => Promise<T>) {
    return this.tenants.withTenantTransaction(
      testContext(member.tenantId, 'responses-probe'),
      work,
    );
  }

  @RequirePermission('player.create')
  @Post()
  create(
    @CurrentUser() member: User,
    @Body({ schema: NewPlayer }) { fullName }: NewPlayer,
  ) {
    return this.as(member, (tx) =>
      tx.player.create({
        data: { tenantId: member.tenantId, fullName },
        select: PLAYER,
      }),
    );
  }

  @RequirePermission('player.read')
  @Get()
  list(@CurrentUser() member: User) {
    return this.as(member, (tx) =>
      tx.player.findMany({
        where: { tenantId: member.tenantId },
        select: PLAYER,
      }),
    );
  }

  @RequirePermission('player.read')
  @Get(':id')
  async read(
    @CurrentUser() member: User,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const player = await this.as(member, (tx) =>
      tx.player.findFirst({
        where: { id, tenantId: member.tenantId },
        select: PLAYER,
      }),
    );
    if (!player) throw new NotFoundError('Player not found');
    return player;
  }

  @RequirePermission('player.delete')
  @Delete(':id')
  async remove(
    @CurrentUser() member: User,
    @Param({ schema: IdParams }) { id }: IdParams,
  ): Promise<void> {
    await this.as(member, (tx) =>
      tx.player.deleteMany({ where: { id, tenantId: member.tenantId } }),
    );
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('one success envelope', () => {
  let booted: BootedApp;
  let member: Record<string, string>;

  beforeAll(async () => {
    booted = await bootApp({
      controllers: [PlayersProbeController],
    });
    const owner = await createMember(await createTenant(), 'OWNER');
    member = await signedInAs(owner);
    vi.spyOn(PermissionService.prototype, 'hasPermission').mockResolvedValue(
      true,
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await booted?.app.close();
  });

  async function createPlayer(): Promise<Record<string, unknown>> {
    const response = await booted.http
      .post('/api/v1/probe/players')
      .set(member)
      .send({ fullName: 'Test Player Envelope' });
    expect(response.status).toBe(201);
    return response.body as Record<string, unknown>;
  }

  it('a_single_resource_is_wrapped_once', async () => {
    const created = await createPlayer();
    expect(Object.keys(created)).toEqual(['data']);
    const { id } = created.data as { id: string };

    const read = await booted.http
      .get(`/api/v1/probe/players/${id}`)
      .set(member);
    expect(read.status).toBe(200);
    const body = read.body as { data: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body).toMatchObject({
      data: { id, fullName: 'Test Player Envelope' },
    });
    // Nothing of a prebuilt body inside it.
    for (const key of ['data', 'statusCode', 'message', 'meta']) {
      expect(body.data).not.toHaveProperty(key);
    }

    const list = await booted.http.get('/api/v1/probe/players').set(member);
    const listed = list.body as { data: unknown[] };
    expect(Object.keys(listed)).toEqual(['data']);
    expect(listed.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
  });

  it('a_not_found_is_never_a_200', async () => {
    for (const path of [
      '/api/v1/probe/players',
      '/api/v1/medical/records',
      '/api/v1/medical/sessions',
      '/api/v1/scouting/reports',
    ]) {
      const response = await booted.http
        .get(`${path}/${randomUUID()}`)
        .set(member);
      expect([path, response.status]).toEqual([path, 404]);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(response.body).not.toHaveProperty('data');
    }
  });

  it('timestamps_are_iso_utc', async () => {
    const { data } = (await createPlayer()) as {
      data: { createdAt: string; updatedAt: string };
    };
    expect(data.createdAt).toMatch(ISO_UTC);
    expect(data.updatedAt).toMatch(ISO_UTC);
  });

  it('a_command_with_nothing_to_return_answers_data_null', async () => {
    const { data } = (await createPlayer()) as { data: { id: string } };
    const response = await booted.http
      .delete(`/api/v1/probe/players/${data.id}`)
      .set(member);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: null });
  });
});
