import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Location } from '../../shared/types';
import { createLocation, loginAsBooker, makeTestApp, readJson, type AuthHeaders, type TestApp } from '../test/helpers';

let t: TestApp;
let headers: AuthHeaders;

beforeEach(async () => {
  t = makeTestApp();
  ({ headers } = await loginAsBooker(t, { role: 'booker' }));
});

afterEach(() => {
  t.close();
});

async function list(query = ''): Promise<Location[]> {
  const res = await t.request(`/api/locations${query}`, { headers });
  expect(res.status).toBe(200);
  return readJson<Location[]>(res);
}

describe('locations API', () => {
  it('requires a booker', async () => {
    expect((await t.request('/api/locations')).status).toBe(401);
    expect((await t.request('/api/locations', { method: 'POST', json: { name: 'X' } })).status).toBe(401);
  });

  it('creates locations with the next palette color and sort order', async () => {
    const a = await t.request('/api/locations', { method: 'POST', headers, json: { name: ' The Cellar ' } });
    expect(a.status).toBe(201);
    expect(await readJson(a)).toMatchObject({ name: 'The Cellar', address: '', color: '#7c5cff', sortOrder: 0 });

    const b = await t.request('/api/locations', {
      method: 'POST',
      headers,
      json: { name: 'The Annex', address: '216 Sullivan St' },
    });
    expect(await readJson(b)).toMatchObject({ color: '#f08c2e', sortOrder: 1, address: '216 Sullivan St' });

    const c = await t.request('/api/locations', { method: 'POST', headers, json: { name: 'Roof', color: '#123abc' } });
    expect(await readJson(c)).toMatchObject({ color: '#123abc', sortOrder: 2 });

    expect((await list()).map((l) => l.name)).toEqual(['The Cellar', 'The Annex', 'Roof']);
  });

  it('validates input', async () => {
    for (const json of [{ name: '' }, { name: 'X', color: 'red' }, {}]) {
      const res = await t.request('/api/locations', { method: 'POST', headers, json });
      expect(res.status).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error' });
    }
  });

  it('updates and archives; archived locations are hidden unless asked for', async () => {
    const loc = createLocation(t.db, { name: 'Old Room' });
    const res = await t.request(`/api/locations/${loc.id}`, {
      method: 'PATCH',
      headers,
      json: { name: 'New Room', archived: true },
    });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ id: loc.id, name: 'New Room', archived: true });

    expect(await list()).toEqual([]);
    expect((await list('?includeArchived=1')).map((l) => l.name)).toEqual(['New Room']);

    expect((await t.request('/api/locations/999', { method: 'PATCH', headers, json: { name: 'X' } })).status).toBe(404);
    expect((await t.request(`/api/locations/${loc.id}`, { method: 'PATCH', headers, json: {} })).status).toBe(400);
    expect((await t.request('/api/locations/abc', { method: 'PATCH', headers, json: { name: 'X' } })).status).toBe(400);
  });

  it('reorders: listed ids first, the rest keep their order after them', async () => {
    const [a, b, c] = ['A', 'B', 'C'].map((name, i) => createLocation(t.db, { name, sortOrder: i }));
    const res = await t.request('/api/locations/reorder', { method: 'POST', headers, json: { ids: [c!.id, a!.id] } });
    expect(res.status).toBe(200);
    expect((await readJson<Location[]>(res)).map((l) => [l.name, l.sortOrder])).toEqual([
      ['C', 0],
      ['A', 1],
      ['B', 2],
    ]);
    expect(b).toBeDefined();

    const bad = await t.request('/api/locations/reorder', { method: 'POST', headers, json: { ids: [999] } });
    expect(bad.status).toBe(400);
  });
});
