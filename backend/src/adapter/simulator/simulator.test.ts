// simulator.test exercises the AM v3 simulator through its UpstreamTransport,
// asserting the documented semantics (etags, uniqueness, update rules,
// delete constraints, filters, pagination, files, persistence).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SimulatorRegistry } from './registry.js';
import {
  simHarness,
  silentLogger,
  type SimCallOptions,
} from '../../test-support/helpers.js';
import type { HttpMethod } from '../../domain/upstream/transport.js';

let h: ReturnType<typeof simHarness>;
let call: (
  method: HttpMethod,
  path: string,
  o?: SimCallOptions,
) => ReturnType<ReturnType<typeof simHarness>['call']>;

beforeEach(() => {
  h = simHarness('acme');
  call = h.call;
});

afterEach(async () => {
  await h.cleanup();
});

const motorAspect = {
  name: 'Motor',
  category: 'static',
  scope: 'private',
  description: 'Motor data',
  variables: [
    { name: 'rpm', dataType: 'DOUBLE', unit: '1/min', searchable: true },
    { name: 'serial', dataType: 'STRING', length: 50 },
  ],
};

async function root(): Promise<{ assetId: string; etag: number }> {
  const r = await call('GET', '/assets/root');
  return r.json as { assetId: string; etag: number };
}

async function createPumpType(
  extra: Record<string, unknown> = {},
): Promise<void> {
  expect(
    (await call('PUT', '/aspecttypes/acme.Motor', { body: motorAspect }))
      .status,
  ).toBe(201);
  const res = await call('PUT', '/assettypes/acme.Pump', {
    body: {
      name: 'Pump',
      parentTypeId: 'core.basicasset',
      instantiable: true,
      variables: [
        {
          name: 'capacity',
          dataType: 'DOUBLE',
          unit: 'm3/h',
          defaultValue: '10',
        },
        { name: 'label', dataType: 'STRING', length: 20 },
      ],
      aspects: [{ name: 'motor', aspectTypeId: 'acme.Motor' }],
      ...extra,
    },
  });
  expect(res.status).toBe(201);
}

async function createAsset(
  name: string,
  parentId: string,
  typeId = 'acme.Pump',
  extra: Record<string, unknown> = {},
) {
  const res = await call('POST', '/assets', {
    body: { name, typeId, parentId, ...extra },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { assetId: string; etag: number; [k: string]: unknown };
}

describe('root asset', () => {
  it('exists, is of type core.basicenterprise and has an empty hierarchy path', async () => {
    const res = await call('GET', '/assets/root');
    expect(res.status).toBe(200);
    expect(res.json.typeId).toBe('core.basicenterprise');
    expect(res.json.name).toBe('acme');
    expect(res.json.hierarchyPath).toEqual([]);
    expect(res.json.parentId).toBeUndefined();
    expect(res.headers.etag).toBe('0');
  });

  it('cannot be deleted', async () => {
    const r = await root();
    const res = await call('DELETE', `/assets/${r.assetId}`, {
      ifMatch: r.etag,
    });
    expect(res.status).toBe(400);
    expect(res.json.errors[0].message).toMatch(/root asset/i);
    expect(res.json.errors[0].logref).toBeTruthy();
  });

  it('answers 304 for a matching If-None-Match', async () => {
    const res = await call('GET', '/assets/root', { ifNoneMatch: '0' });
    expect(res.status).toBe(304);
  });
});

describe('core types', () => {
  it('are seeded and read-only', async () => {
    const list = await call('GET', '/assettypes', { query: { size: '200' } });
    const ids = list.json._embedded.assetTypes.map((t: { id: string }) => t.id);
    expect(ids).toContain('core.basicasset');
    expect(ids).toContain('core.basicenterprise');

    const put = await call('PUT', '/aspecttypes/core.contactpoint', {
      ifMatch: 1,
      body: {
        name: 'ContactPoint',
        category: 'static',
        scope: 'private',
        variables: [{ name: 'x', dataType: 'INT' }],
      },
    });
    expect(put.status).toBe(400);
    const del = await call('DELETE', '/assettypes/core.basicasset', {
      ifMatch: 1,
    });
    expect(del.status).toBe(400);
  });
});

describe('aspect types', () => {
  it('creates with etag 0 and rejects If-None-Match:* on an existing type', async () => {
    const created = await call('PUT', '/aspecttypes/acme.Motor', {
      body: motorAspect,
    });
    expect(created.status).toBe(201);
    expect(created.json.etag).toBe(0);
    expect(created.headers.etag).toBe('0');
    expect(created.json.variables[0]).toMatchObject({
      name: 'rpm',
      qualityCode: false,
      length: null,
    });
    expect(created.json.variables[1]).toMatchObject({
      name: 'serial',
      length: 50,
    });

    const again = await call('PUT', '/aspecttypes/acme.Motor', {
      body: motorAspect,
      ifNoneMatch: '*',
    });
    expect(again.status).toBe(412);
  });

  it('treats ids and names case-insensitively', async () => {
    await call('PUT', '/aspecttypes/acme.Motor', { body: motorAspect });
    const sameIdOtherCase = await call('PUT', '/aspecttypes/ACME.motor', {
      body: motorAspect,
      ifNoneMatch: '*',
    });
    expect(sameIdOtherCase.status).toBe(412);
    const sameName = await call('PUT', '/aspecttypes/acme.Other', {
      body: { ...motorAspect, name: 'MOTOR' },
    });
    expect(sameName.status).toBe(400);
    expect(sameName.json.errors[0].message).toMatch(/already exists/);
    const get = await call('GET', '/aspecttypes/ACME.MOTOR');
    expect(get.status).toBe(200);
    expect(get.json.id).toBe('acme.Motor');
  });

  it('requires the tenant prefix', async () => {
    const res = await call('PUT', '/aspecttypes/other.Motor', {
      body: motorAspect,
    });
    expect(res.status).toBe(400);
  });

  it('enforces optimistic locking on update (412 stale, 400 missing)', async () => {
    await call('PUT', '/aspecttypes/acme.Motor', { body: motorAspect });
    const updated = { ...motorAspect, description: 'changed' };
    expect(
      (await call('PUT', '/aspecttypes/acme.Motor', { body: updated })).status,
    ).toBe(400);
    expect(
      (
        await call('PUT', '/aspecttypes/acme.Motor', {
          body: updated,
          ifMatch: 7,
        })
      ).status,
    ).toBe(412);
    const ok = await call('PUT', '/aspecttypes/acme.Motor', {
      body: updated,
      ifMatch: 0,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.etag).toBe(1);
    expect(ok.json.description).toBe('changed');
    expect(
      (
        await call('PUT', '/aspecttypes/acme.Motor', {
          body: updated,
          ifMatch: '"0"',
        })
      ).status,
    ).toBe(412);
  });

  it('only allows restricted variable updates via PUT/PATCH', async () => {
    await call('PUT', '/aspecttypes/acme.Motor', { body: motorAspect });
    const vars = motorAspect.variables;
    const dataTypeChange = await call('PUT', '/aspecttypes/acme.Motor', {
      ifMatch: 0,
      body: {
        ...motorAspect,
        variables: [{ ...vars[0], dataType: 'INT' }, vars[1]],
      },
    });
    expect(dataTypeChange.status).toBe(400);
    const removal = await call('PUT', '/aspecttypes/acme.Motor', {
      ifMatch: 0,
      body: { ...motorAspect, variables: [vars[0]] },
    });
    expect(removal.status).toBe(400);
    const shorter = await call('PUT', '/aspecttypes/acme.Motor', {
      ifMatch: 0,
      body: {
        ...motorAspect,
        variables: [vars[0], { ...vars[1], length: 10 }],
      },
    });
    expect(shorter.status).toBe(400);
    const longerAndAdded = await call('PATCH', '/aspecttypes/acme.Motor', {
      ifMatch: 0,
      body: {
        variables: [
          vars[0],
          { ...vars[1], length: 80 },
          { name: 'temp', dataType: 'DOUBLE', unit: 'C' },
        ],
      },
    });
    expect(longerAndAdded.status).toBe(200);
    expect(
      longerAndAdded.json.variables.map((v: { name: string }) => v.name),
    ).toEqual(['rpm', 'serial', 'temp']);
    expect(longerAndAdded.json.variables[1].length).toBe(80);
    const rename = await call('PATCH', '/aspecttypes/acme.Motor', {
      ifMatch: 1,
      body: { name: 'Engine' },
    });
    expect(rename.status).toBe(400);
  });

  it('rejects default values on dynamic aspect variables and BIG_STRING on static ones', async () => {
    const dyn = await call('PUT', '/aspecttypes/acme.Live', {
      body: {
        name: 'Live',
        category: 'dynamic',
        scope: 'private',
        variables: [{ name: 'v', dataType: 'DOUBLE', defaultValue: '1' }],
      },
    });
    expect(dyn.status).toBe(400);
    const big = await call('PUT', '/aspecttypes/acme.Doc', {
      body: {
        name: 'Doc',
        category: 'static',
        scope: 'private',
        variables: [{ name: 'v', dataType: 'BIG_STRING' }],
      },
    });
    expect(big.status).toBe(400);
  });

  it('adds, renames and deletes variables via PATCH .../variables', async () => {
    await call('PUT', '/aspecttypes/acme.Motor', { body: motorAspect });
    const res = await call('PATCH', '/aspecttypes/acme.Motor/variables', {
      ifMatch: 0,
      body: {
        rpm: { name: 'speed', unit: 'rpm' },
        serial: null,
        torque: { dataType: 'DOUBLE', unit: 'Nm' },
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.etag).toBe('1');
    const get = await call('GET', '/aspecttypes/acme.Motor');
    expect(get.json.variables.map((v: { name: string }) => v.name)).toEqual([
      'speed',
      'torque',
    ]);
    expect(get.json.variables[0].unit).toBe('rpm');

    const dup = await call('PATCH', '/aspecttypes/acme.Motor/variables', {
      ifMatch: 1,
      body: { torque: { name: 'SPEED' } },
    });
    expect(dup.status).toBe(400);
    expect(dup.json.errors[0].message).toMatch(/unique/);
    const missing = await call('PATCH', '/aspecttypes/acme.Motor/variables', {
      ifMatch: 1,
      body: { nope: null },
    });
    expect(missing.status).toBe(404);
    const stale = await call('PATCH', '/aspecttypes/acme.Motor/variables', {
      ifMatch: 0,
      body: { speed: { unit: 'x' } },
    });
    expect(stale.status).toBe(412);
    const wrongType = await call('PATCH', '/aspecttypes/acme.Motor/variables', {
      ifMatch: 1,
      contentType: 'application/json',
      body: { speed: { unit: 'x' } },
    });
    expect(wrongType.status).toBe(415);
  });

  it('cannot be deleted while an asset type uses it', async () => {
    await createPumpType();
    const del = await call('DELETE', '/aspecttypes/acme.Motor', { ifMatch: 0 });
    expect(del.status).toBe(400);
    expect(del.json.errors[0].message).toMatch(/acme.Pump/);
  });
});

describe('asset types', () => {
  it('creates aspects with generated aspectIds and renders the aspect type', async () => {
    await createPumpType();
    const get = await call('GET', '/assettypes/acme.Pump');
    expect(get.json.aspects[0].aspectId).toMatch(/^[0-9a-f]{32}$/);
    expect(get.json.aspects[0].aspectType.id).toBe('acme.Motor');
    expect(get.json.variables.map((v: { name: string }) => v.name)).toEqual([
      'capacity',
      'label',
    ]);
    expect(get.json.parentTypeId).toBe('core.basicasset');
  });

  it('includes inherited variables and aspects with origin links when exploded', async () => {
    await createPumpType();
    const child = await call('PUT', '/assettypes/acme.BigPump', {
      body: {
        name: 'Big Pump',
        parentTypeId: 'acme.Pump',
        variables: [{ name: 'stages', dataType: 'INT' }],
      },
    });
    expect(child.status).toBe(201);
    const plain = await call('GET', '/assettypes/acme.BigPump');
    expect(plain.json.variables.map((v: { name: string }) => v.name)).toEqual([
      'stages',
    ]);
    const exploded = await call('GET', '/assettypes/acme.BigPump', {
      query: { exploded: 'true' },
    });
    const names = exploded.json.variables.map((v: { name: string }) => v.name);
    expect(names).toEqual(['externalId', 'capacity', 'label', 'stages']);
    expect(exploded.json.variables[1]._links.origin.href).toMatch(
      /assettypes\/acme.Pump$/,
    );
    expect(exploded.json.variables[3]._links).toBeUndefined();
    expect(exploded.json.aspects[0]._links.origin.href).toMatch(/acme.Pump$/);
  });

  it('enforces unique variable and aspect names in the type family', async () => {
    await createPumpType();
    const clash = await call('PUT', '/assettypes/acme.BigPump', {
      body: {
        name: 'Big Pump',
        parentTypeId: 'acme.Pump',
        variables: [{ name: 'CAPACITY', dataType: 'INT' }],
      },
    });
    expect(clash.status).toBe(400);
    const coreClash = await call('PUT', '/assettypes/acme.Thing', {
      body: {
        name: 'Thing',
        parentTypeId: 'core.basicasset',
        variables: [{ name: 'externalId', dataType: 'STRING' }],
      },
    });
    expect(coreClash.status).toBe(400);
    const aspectClash = await call('PUT', '/assettypes/acme.BigPump', {
      body: {
        name: 'Big Pump',
        parentTypeId: 'acme.Pump',
        aspects: [{ name: 'Motor', aspectTypeId: 'acme.Motor' }],
      },
    });
    expect(aspectClash.status).toBe(400);
    const nameClash = await call('PUT', '/assettypes/acme.Pump2', {
      body: { name: 'PUMP', parentTypeId: 'core.basicasset' },
    });
    expect(nameClash.status).toBe(400);
  });

  it('rejects BIG_STRING variables and parentTypeId / instantiable downgrades', async () => {
    await createPumpType();
    const big = await call('PUT', '/assettypes/acme.T2', {
      body: {
        name: 'T2',
        parentTypeId: 'core.basicasset',
        variables: [{ name: 'doc', dataType: 'BIG_STRING' }],
      },
    });
    expect(big.status).toBe(400);
    const reparent = await call('PATCH', '/assettypes/acme.Pump', {
      ifMatch: 0,
      body: { parentTypeId: 'core.basicdevice' },
    });
    expect(reparent.status).toBe(400);
    const abstract = await call('PATCH', '/assettypes/acme.Pump', {
      ifMatch: 0,
      body: { instantiable: false },
    });
    expect(abstract.status).toBe(400);
  });

  it('updates aspects by aspectId and removes omitted ones', async () => {
    await createPumpType();
    const get = await call('GET', '/assettypes/acme.Pump');
    const aspectId = get.json.aspects[0].aspectId as string;
    const renamed = await call('PATCH', '/assettypes/acme.Pump', {
      ifMatch: 0,
      body: {
        aspects: [{ name: 'drive', aspectId, aspectTypeId: 'acme.Motor' }],
      },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.aspects[0]).toMatchObject({ name: 'drive', aspectId });
    const removed = await call('PATCH', '/assettypes/acme.Pump', {
      ifMatch: 1,
      body: { aspects: [] },
    });
    expect(removed.json.aspects).toEqual([]);
  });

  describe('PATCH /assettypes/{id}/variables', () => {
    beforeEach(async () => {
      await createPumpType();
    });

    it('renames and updates unit/length/defaultValue, returning 204 with ETag', async () => {
      const res = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: {
          capacity: { name: 'flow', unit: 'l/s', defaultValue: '12.5' },
          label: { length: 40 },
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.etag).toBe('1');
      expect(res.bytes.byteLength).toBe(0);
      const get = await call('GET', '/assettypes/acme.Pump');
      expect(get.json.variables[0]).toMatchObject({
        name: 'flow',
        unit: 'l/s',
        defaultValue: '12.5',
      });
      expect(get.json.variables[1].length).toBe(40);
      expect(get.json.etag).toBe(1);
    });

    it('rejects interchanging names within one request', async () => {
      const res = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: { capacity: { name: 'label' }, label: { name: 'capacity' } },
      });
      expect(res.status).toBe(400);
      expect(res.json.errors[0].message).toMatch(/interchanged/);
      const unchanged = await call('GET', '/assettypes/acme.Pump');
      expect(unchanged.json.etag).toBe(0);
    });

    it('rejects dataType/searchable changes, length decrease, deletes and inherited variables', async () => {
      const dt = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: { capacity: { dataType: 'INT' } },
      });
      expect(dt.status).toBe(400);
      const searchable = await call(
        'PATCH',
        '/assettypes/acme.Pump/variables',
        { ifMatch: 0, body: { capacity: { searchable: true } } },
      );
      expect(searchable.status).toBe(400);
      const shorter = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: { label: { length: 5 } },
      });
      expect(shorter.status).toBe(400);
      const del = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: { label: null },
      });
      expect(del.status).toBe(400);
      const inherited = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: { externalId: { unit: 'x' } },
      });
      expect(inherited.status).toBe(400);
      const unknown = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: { nope: { unit: 'x' } },
      });
      expect(unknown.status).toBe(404);
      const stale = await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 3,
        body: { label: { unit: 'x' } },
      });
      expect(stale.status).toBe(412);
    });

    it('propagates renames to asset values', async () => {
      const r = await root();
      const a = await createAsset('P1', r.assetId, 'acme.Pump', {
        variables: [{ name: 'label', value: 'x' }],
      });
      await call('PATCH', '/assettypes/acme.Pump/variables', {
        ifMatch: 0,
        body: { label: { name: 'tag' } },
      });
      const get = await call('GET', `/assets/${a.assetId}`);
      expect(get.json.variables).toContainEqual({ name: 'tag', value: 'x' });
    });
  });

  it('cannot be deleted with child types or instances', async () => {
    await createPumpType();
    await call('PUT', '/assettypes/acme.BigPump', {
      body: { name: 'Big Pump', parentTypeId: 'acme.Pump' },
    });
    expect(
      (await call('DELETE', '/assettypes/acme.Pump', { ifMatch: 0 })).status,
    ).toBe(400);
    const r = await root();
    const a = await createAsset('B1', r.assetId, 'acme.BigPump');
    expect(
      (await call('DELETE', '/assettypes/acme.BigPump', { ifMatch: 0 })).status,
    ).toBe(400);
    expect(
      (await call('DELETE', `/assets/${a.assetId}`, { ifMatch: 0 })).status,
    ).toBe(204);
    expect((await call('DELETE', '/assettypes/acme.BigPump')).status).toBe(400);
    expect(
      (await call('DELETE', '/assettypes/acme.BigPump', { ifMatch: 0 })).status,
    ).toBe(204);
    expect(
      (await call('DELETE', '/assettypes/acme.Pump', { ifMatch: 0 })).status,
    ).toBe(204);
    expect((await call('GET', '/assettypes/acme.Pump')).status).toBe(404);
  });

  it('rejects updates while the model lock is enabled', async () => {
    await createPumpType();
    expect(
      (await call('PUT', '/model/lock', { query: { enabled: 'true' } })).json,
    ).toEqual({ enabled: true });
    expect((await call('GET', '/model/lock')).json).toEqual({
      enabled: true,
      jobs: [],
    });
    const res = await call('PATCH', '/assettypes/acme.Pump', {
      ifMatch: 0,
      body: { description: 'x' },
    });
    expect(res.status).toBe(400);
    expect(res.json.errors[0].message).toMatch(/locked/);
  });
});

describe('assets', () => {
  beforeEach(async () => {
    await createPumpType();
  });

  it('creates with defaults (timezone, twinType), hierarchy path and default values', async () => {
    const r = await root();
    const site = await createAsset('Site', r.assetId, 'core.basicsite', {
      location: { latitude: 54.8, longitude: 14.1 },
    });
    const pump = await createAsset('P1', site.assetId, 'acme.Pump', {
      variables: [{ name: 'label', value: 'pump one' }],
      aspects: [{ name: 'motor', variables: [{ name: 'rpm', value: '1450' }] }],
    });
    expect(pump.etag).toBe(0);
    expect(pump.timezone).toBe('Europe/Berlin');
    expect(pump.twinType).toBe('performance');
    expect(pump.hierarchyPath).toEqual([
      { assetId: r.assetId, name: 'acme' },
      { assetId: site.assetId, name: 'Site' },
    ]);
    expect(pump.variables).toEqual([
      { name: 'capacity', value: '10' },
      { name: 'label', value: 'pump one' },
    ]);
    expect(pump.aspects).toEqual([
      { name: 'motor', variables: [{ name: 'rpm', value: '1450' }] },
    ]);
    expect((pump.location as { latitude: number }).latitude).toBe(54.8);
  });

  it('validates type, parent, variables and values', async () => {
    const r = await root();
    const bad = async (body: Record<string, unknown>) =>
      (
        await call('POST', '/assets', {
          body: {
            name: 'X',
            typeId: 'acme.Pump',
            parentId: r.assetId,
            ...body,
          },
        })
      ).status;
    expect(await bad({ typeId: 'core.basicasset' })).toBe(400); // not instantiable
    expect(await bad({ typeId: 'core.basicsubtenant' })).toBe(400); // root hierarchy type
    expect(await bad({ typeId: 'acme.Nope' })).toBe(400);
    expect(await bad({ parentId: '0123456789abcdef0123456789abcdef' })).toBe(
      400,
    );
    expect(await bad({ variables: [{ name: 'nope', value: '1' }] })).toBe(400);
    expect(await bad({ variables: [{ name: 'capacity', value: 'abc' }] })).toBe(
      400,
    );
    expect(
      await bad({ variables: [{ name: 'label', value: 'x'.repeat(21) }] }),
    ).toBe(400);
    expect(await bad({ timezone: 'Asia/Kathmandu' })).toBe(400);
    expect(await bad({ timezone: 'Mars/Base' })).toBe(400);
    expect(await bad({ name: 'a/b' })).toBe(400);
  });

  it('updates only values; If-Match is mandatory; typeId/timezone are immutable', async () => {
    const r = await root();
    const a = await createAsset('P1', r.assetId);
    expect(
      (await call('PUT', `/assets/${a.assetId}`, { body: { name: 'P1b' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('PUT', `/assets/${a.assetId}`, {
          body: { name: 'P1b' },
          ifMatch: 5,
        })
      ).status,
    ).toBe(412);
    const put = await call('PUT', `/assets/${a.assetId}`, {
      ifMatch: 0,
      body: {
        name: 'P1b',
        description: 'renamed',
        variables: [{ name: 'capacity', value: '20' }],
      },
    });
    expect(put.status).toBe(200);
    expect(put.json.etag).toBe(1);
    expect(put.json.variables).toContainEqual({
      name: 'capacity',
      value: '20',
    });
    const typeChange = await call('PUT', `/assets/${a.assetId}`, {
      ifMatch: 1,
      body: { name: 'P1b', typeId: 'core.basicsite' },
    });
    expect(typeChange.status).toBe(400);
    const tz = await call('PATCH', `/assets/${a.assetId}`, {
      ifMatch: 1,
      body: { timezone: 'UTC' },
    });
    expect(tz.status).toBe(400);
    const patch = await call('PATCH', `/assets/${a.assetId}`, {
      ifMatch: 1,
      body: { description: null, externalId: 'E-1' },
    });
    expect(patch.status).toBe(200);
    expect(patch.json).toMatchObject({
      name: 'P1b',
      externalId: 'E-1',
      description: null,
      etag: 2,
    });
    expect(patch.json.variables).toContainEqual({
      name: 'capacity',
      value: '20',
    });
  });

  it('rejects deleting assets with children and moving into the own subtree', async () => {
    const r = await root();
    const parent = await createAsset('Parent', r.assetId, 'core.basicarea');
    const child = await createAsset('Child', parent.assetId, 'core.basicarea');
    expect(
      (await call('DELETE', `/assets/${parent.assetId}`, { ifMatch: 0 }))
        .status,
    ).toBe(400);
    const intoChild = await call('POST', `/assets/${parent.assetId}/move`, {
      ifMatch: 0,
      body: { newParentId: child.assetId },
    });
    expect(intoChild.status).toBe(400);
    const moved = await call('POST', `/assets/${child.assetId}/move`, {
      ifMatch: 0,
      body: { newParentId: r.assetId },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.parentId).toBe(r.assetId);
    expect(moved.json.etag).toBe(1);
    expect(
      (await call('DELETE', `/assets/${parent.assetId}`, { ifMatch: 0 }))
        .status,
    ).toBe(204);
  });

  it('manages the own location and inherits the parent location', async () => {
    const r = await root();
    const site = await createAsset('Site', r.assetId, 'core.basicsite');
    const pump = await createAsset('P1', site.assetId);
    expect(
      (await call('DELETE', `/assets/${site.assetId}/location`, { ifMatch: 0 }))
        .status,
    ).toBe(409);
    const put = await call('PUT', `/assets/${site.assetId}/location`, {
      ifMatch: 0,
      body: { country: 'Germany', latitude: 48.1 },
    });
    expect(put.status).toBe(200);
    expect(put.json.location).toMatchObject({
      country: 'Germany',
      latitude: 48.1,
      locality: null,
    });
    const inherited = await call('GET', `/assets/${pump.assetId}`);
    expect(inherited.json.location.country).toBe('Germany');
    const bad = await call('PUT', `/assets/${site.assetId}/location`, {
      ifMatch: 1,
      body: { latitude: 120 },
    });
    expect(bad.status).toBe(400);
    const del = await call('DELETE', `/assets/${site.assetId}/location`, {
      ifMatch: 1,
    });
    expect(del.status).toBe(200);
    expect(del.json.location).toBeUndefined();
  });

  it('lists variables and aspects of an asset (paginated)', async () => {
    const r = await root();
    const a = await createAsset('P1', r.assetId);
    const vars = await call('GET', `/assets/${a.assetId}/variables`);
    expect(
      vars.json._embedded.variables.map((v: { name: string }) => v.name),
    ).toEqual(['capacity', 'externalId', 'label']);
    const aspects = await call('GET', `/assets/${a.assetId}/aspects`);
    expect(aspects.json._embedded.aspects[0]).toMatchObject({
      name: 'motor',
      aspectTypeId: 'acme.Motor',
      holderAssetId: a.assetId,
      category: 'static',
    });
    expect(aspects.json.page).toEqual({
      size: 10,
      totalElements: 1,
      totalPages: 1,
      number: 0,
    });
  });
});

describe('list queries', () => {
  beforeEach(async () => {
    await createPumpType();
    const r = await root();
    for (let i = 0; i < 24; i++) {
      await createAsset(
        `Pump-${String(i).padStart(2, '0')}`,
        r.assetId,
        i % 2 === 0 ? 'acme.Pump' : 'core.basicarea',
      );
    }
  });

  it('pages with default size 10 and HAL page metadata', async () => {
    const p0 = await call('GET', '/assets');
    expect(p0.json.page).toEqual({
      size: 10,
      totalElements: 25,
      totalPages: 3,
      number: 0,
    });
    expect(p0.json._embedded.assets).toHaveLength(10);
    expect(p0.json._links.next.href).toContain('page=1');
    const p2 = await call('GET', '/assets', { query: { page: '2' } });
    expect(p2.json._embedded.assets).toHaveLength(5);
    const big = await call('GET', '/assets', { query: { size: '200' } });
    expect(big.json._embedded.assets).toHaveLength(25);
    expect(
      (await call('GET', '/assets', { query: { size: '0' } })).status,
    ).toBe(400);
  });

  it('sorts by name ascending by default and supports ",desc"', async () => {
    const asc = await call('GET', '/assets', { query: { size: '3' } });
    expect(
      asc.json._embedded.assets.map((a: { name: string }) => a.name),
    ).toEqual(['acme', 'Pump-00', 'Pump-01']);
    const desc = await call('GET', '/assets', {
      query: { size: '2', sort: 'name,desc' },
    });
    expect(
      desc.json._embedded.assets.map((a: { name: string }) => a.name),
    ).toEqual(['Pump-23', 'Pump-22']);
    expect(
      (await call('GET', '/assets', { query: { sort: 'variables' } })).status,
    ).toBe(400);
  });

  it('filters with eq/in/startsWith/endsWith/contains/not/or/and/hasType', async () => {
    const count = async (filter: unknown) => {
      const res = await call('GET', '/assets', {
        query: { size: '200', filter: JSON.stringify(filter) },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return res.json.page.totalElements as number;
    };
    expect(await count({ name: 'Pump-03' })).toBe(1);
    expect(await count({ name: { eq: 'Pump-03' } })).toBe(1);
    expect(
      await count({ name: { in: { value: ['Pump-01', 'Pump-02', 'x'] } } }),
    ).toBe(2);
    expect(await count({ name: { startsWith: 'Pump-1' } })).toBe(10);
    expect(await count({ name: { endsWith: '3' } })).toBe(3);
    expect(await count({ name: { contains: 'mp-2' } })).toBe(4);
    expect(await count({ not: { name: { startsWith: 'Pump' } } })).toBe(1);
    expect(
      await count({ name: { or: [{ eq: 'Pump-01' }, { endsWith: '22' }] } }),
    ).toBe(2);
    expect(
      await count({ or: { name: 'acme', typeId: 'core.basicarea' } }),
    ).toBe(13);
    expect(
      await count({
        and: { typeId: 'acme.Pump', name: { startsWith: 'Pump-0' } },
      }),
    ).toBe(5);
    expect(await count({ typeId: 'core.basicasset' })).toBe(0);
    expect(await count({ hasType: 'core.basicasset' })).toBe(25);
    expect(await count({ hasType: 'core.basichierarchy' })).toBe(13);
    expect(await count({ unknownField: 'ignored' })).toBe(25);
    const bad = await call('GET', '/assets', { query: { filter: '{"name":' } });
    expect(bad.status).toBe(400);
    const badFn = await call('GET', '/assets', {
      query: { filter: '{"name":{"like":"x"}}' },
    });
    expect(badFn.status).toBe(400);
  });

  it('omits variables and aspects with basicFieldsOnly', async () => {
    const res = await call('GET', '/assets', {
      query: { basicFieldsOnly: 'true', size: '1' },
    });
    expect(res.json._embedded.assets[0].variables).toBeUndefined();
    expect(res.json._embedded.assets[0].name).toBeDefined();
  });
});

describe('files', () => {
  const form =
    (name: string, fileName: string, type: string, content = 'hello') =>
    () => {
      const f = new FormData();
      f.append('file', new Blob([content], { type }), fileName);
      f.append('name', name);
      f.append('scope', 'private');
      return f;
    };

  it('uploads, downloads, assigns, blocks deletion while assigned', async () => {
    const up = await call('POST', '/files', {
      form: form('manual.txt', 'manual.txt', 'text/plain'),
    });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({
      name: 'manual.txt',
      originalFileName: 'manual.txt',
      etag: 0,
      isAssigned: false,
      scope: 'private',
    });
    const fileId = up.json.id as string;

    const down = await call('GET', `/files/${fileId}/file`);
    expect(down.status).toBe(200);
    expect(down.headers['content-type']).toBe('text/plain');
    expect(new TextDecoder().decode(down.bytes)).toBe('hello');

    await createPumpType();
    const assigned = await call(
      'PUT',
      '/assettypes/acme.Pump/fileAssignments/manual',
      { ifMatch: 0, body: { fileId } },
    );
    expect(assigned.status).toBe(200);
    expect(assigned.json.fileAssignments[0]).toMatchObject({
      key: 'manual',
      fileId,
    });
    const r = await root();
    const asset = await createAsset('P1', r.assetId);
    expect(
      (asset.fileAssignments as { _links: { origin?: unknown } }[])[0]!._links
        .origin,
    ).toBeDefined();

    expect(
      (await call('DELETE', `/files/${fileId}`, { ifMatch: 0 })).status,
    ).toBe(400);
    expect((await call('GET', `/files/${fileId}`)).json.isAssigned).toBe(true);
    expect(
      (
        await call('DELETE', '/assettypes/acme.Pump/fileAssignments/manual', {
          ifMatch: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('DELETE', `/files/${fileId}`, { ifMatch: 0 })).status,
    ).toBe(204);
    expect((await call('GET', `/files/${fileId}`)).status).toBe(404);
  });

  it('rejects content types that do not match the extension, and replaces with If-Match', async () => {
    const bad = await call('POST', '/files', {
      form: form('x.pdf', 'x.pdf', 'text/plain'),
    });
    expect(bad.status).toBe(400);
    const up = await call('POST', '/files', {
      form: form('data.csv', 'data.csv', 'text/csv'),
    });
    const id = up.json.id as string;
    const stale = await call('PUT', `/files/${id}`, {
      ifMatch: 3,
      form: form('data.csv', 'data.csv', 'text/csv', 'a,b'),
    });
    expect(stale.status).toBe(412);
    const ok = await call('PUT', `/files/${id}`, {
      ifMatch: 0,
      form: form('data.csv', 'data.csv', 'text/csv', 'a,b'),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.etag).toBe(1);
    const list = await call('GET', '/files', {
      query: { filter: JSON.stringify({ name: { endsWith: '.csv' } }) },
    });
    expect(list.json._embedded.files).toHaveLength(1);
  });
});

describe('routing and persistence', () => {
  it('answers 404 for unknown paths and 405 for unsupported methods', async () => {
    expect((await call('GET', '/nothing')).status).toBe(404);
    expect((await call('POST', '/assettypes/acme.X')).status).toBe(405);
  });

  it('persists state per connection and reloads it', async () => {
    await createPumpType();
    await h.registry.flushAll();
    const again = new SimulatorRegistry({
      dataDir: h.dataDir,
      logger: silentLogger,
      clock: { now: () => Date.now() },
      sleep: () => Promise.resolve(),
      latencyMs: 0,
    });
    const res = await again
      .transport(h.connectionId, 'acme')
      .send({ method: 'GET', path: '/assettypes/acme.Pump' });
    expect(res.status).toBe(200);
    await again.destroy(h.connectionId);
    const fresh = new SimulatorRegistry({
      dataDir: h.dataDir,
      logger: silentLogger,
      clock: { now: () => Date.now() },
      sleep: () => Promise.resolve(),
      latencyMs: 0,
    });
    const gone = await fresh
      .transport(h.connectionId, 'acme')
      .send({ method: 'GET', path: '/assettypes/acme.Pump' });
    expect(gone.status).toBe(404);
    await fresh.flushAll();
  });
});
