/**
 * Single-club mode (no PLATFORM_URL) stays exactly as it was: one database for every request,
 * whatever the host; no platform API. The rest of the suite covers its routes unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostContext } from '../shared/api/platform';
import type { MeResponse } from '../shared/types';
import { env } from './env';
import { getAppUrl } from './lib/settings';
import { loginAsBooker, makeTestApp, readJson, TEST_APP_URL, type TestApp } from './test/helpers';

let t: TestApp;

beforeEach(() => {
  t = makeTestApp();
});

afterEach(() => {
  t.close();
});

describe('single-club mode', () => {
  it('runs without PLATFORM_URL in tests', () => {
    expect(env.hosted).toBeNull();
  });

  it('GET /api/host → { mode: single }', async () => {
    const res = await t.request('/api/host');
    expect(res.status).toBe(200);
    expect(await readJson<HostContext>(res)).toEqual({ mode: 'single' });
  });

  it('serves the one club on any host', async () => {
    const { headers } = await loginAsBooker(t);
    for (const url of ['http://localhost/api/auth/me', 'http://broadway.localhost:3000/api/auth/me', 'https://booking.club.example/api/auth/me']) {
      const res = await t.app.request(url, { headers });
      expect(res.status, url).toBe(200);
      expect((await readJson<MeResponse>(res)).club.name, url).toBe('Test Comedy Club');
    }
  });

  it('has no platform API', async () => {
    for (const [method, path] of [
      ['GET', '/api/platform/slug?slug=abc'],
      ['POST', '/api/platform/signup'],
      ['POST', '/api/platform/find-club'],
      ['POST', '/api/auth/handoff'],
    ] as const) {
      const res = await t.request(path, { method, json: method === 'POST' ? { token: 'x'.repeat(20) } : undefined });
      expect(res.status, path).toBe(404);
      expect(await readJson(res)).toEqual({ error: 'Not found', code: 'not_found' });
    }
  });

  it('keeps the app URL from settings (nothing pinned)', () => {
    expect(getAppUrl(t.db)).toBe(TEST_APP_URL);
  });
});
