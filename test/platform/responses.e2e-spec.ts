import { randomUUID } from 'node:crypto';
import type { Tenant } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { bootApp, type BootedApp } from '../harness/app';
import { createMember, createPlayer, createTenant } from '../harness/fixtures';
import { TEST_MEMBER_HEADER } from '../harness/session';

// The medical module switched on before AppModule loads: its routes return
// stored records, which is what an envelope has to wrap.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('one success envelope', () => {
  let booted: BootedApp;
  let tenant: Tenant;
  let member: Record<string, string>;

  beforeAll(async () => {
    booted = await bootApp({ testSessions: true });
    tenant = await createTenant();
    const admin = await createMember(tenant, 'SUPER_ADMIN');
    member = { [TEST_MEMBER_HEADER]: admin.id };
    vi.spyOn(PermissionService.prototype, 'hasPermission').mockResolvedValue(
      true,
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await booted?.app.close();
  });

  async function createRecord(): Promise<Record<string, unknown>> {
    const player = await createPlayer(tenant);
    const response = await booted.http
      .post('/api/v1/medical/records')
      .set(member)
      .send({ playerId: player.id, injuryType: 'Ankle sprain' });
    expect(response.status).toBe(201);
    return response.body as Record<string, unknown>;
  }

  it('a_single_resource_is_wrapped_once', async () => {
    const created = await createRecord();
    expect(Object.keys(created)).toEqual(['data']);
    const { id } = created.data as { id: string };

    const read = await booted.http
      .get(`/api/v1/medical/records/${id}`)
      .set(member);
    expect(read.status).toBe(200);
    const body = read.body as { data: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body).toMatchObject({ data: { id, injuryType: 'Ankle sprain' } });
    // Nothing of a prebuilt body inside it.
    for (const key of ['data', 'statusCode', 'message', 'meta']) {
      expect(body.data).not.toHaveProperty(key);
    }

    const list = await booted.http.get('/api/v1/medical/records').set(member);
    const listed = list.body as { data: unknown[] };
    expect(Object.keys(listed)).toEqual(['data']);
    expect(listed.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
  });

  it('a_not_found_is_never_a_200', async () => {
    for (const path of [
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
    const { data } = (await createRecord()) as {
      data: { createdAt: string; updatedAt: string };
    };
    expect(data.createdAt).toMatch(ISO_UTC);
    expect(data.updatedAt).toMatch(ISO_UTC);

    const health = await booted.http.get('/api/health');
    const checked = health.body as {
      data: { status: string; timestamp: string };
    };
    expect(checked.data.status).toBe('ok');
    expect(checked.data.timestamp).toMatch(ISO_UTC);
  });

  it('a_command_with_nothing_to_return_answers_data_null', async () => {
    const { data } = (await createRecord()) as { data: { id: string } };
    const response = await booted.http
      .delete(`/api/v1/medical/records/${data.id}`)
      .set(member);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: null });
  });
});
