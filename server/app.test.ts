import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BODY_LIMIT_BYTES, createApp } from './app';
import { DEFAULT_RATE_LIMITS, rateLimiter } from './lib/rateLimit';
import { createUser, loginAsBooker, makeTestApp, readJson, TEST_PASSWORD, type TestApp } from './test/helpers';

let t: TestApp;

beforeEach(() => {
  t = makeTestApp();
});

afterEach(() => {
  t.close();
});

function csp(res: Response): Map<string, string> {
  const header = res.headers.get('content-security-policy') ?? '';
  return new Map(
    header
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name!, values.join(' ')] as const;
      }),
  );
}

describe('security headers', () => {
  it('sends a CSP and the usual hardening headers on API responses', async () => {
    const res = await t.request('/api/health');
    expect(res.status).toBe(200);
    const policy = csp(res);
    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('script-src')).toBe("'self'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('img-src')).toBe('* data: blob:');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=15552000');
  });

  it('also on errors, 404s and the SPA shell (production)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cbp-client-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    const app = createApp({ db: t.db, clientDir: dir });

    for (const url of ['/', '/app/settings/account', '/portal/confirm/abc', '/assets/app.js', '/api/nope', '/api/settings']) {
      const res = await app.request(url);
      expect(csp(res).get('frame-ancestors'), url).toBe("'none'");
      expect(res.headers.get('x-frame-options'), url).toBe('DENY');
    }
    const shell = await app.request('/portal/confirm/abc');
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect(shell.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('request body limit (security#2)', () => {
  const big = () => JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(API_BODY_LIMIT_BYTES + 10) });

  it('rejects an oversized JSON body with 413 before parsing it (Content-Length)', async () => {
    const res = await t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big(),
    });
    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({ error: 'That request is too large', code: 'payload_too_large' });
  });

  it('rejects an oversized streamed (chunked) body too', async () => {
    const bytes = new TextEncoder().encode(big());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 64 * 1024) controller.enqueue(bytes.subarray(i, i + 64 * 1024));
        controller.close();
      },
    });
    const res = await t.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: stream,
      duplex: 'half', // Node's fetch needs this for a streamed body
    });
    expect(res.status).toBe(413);
  });

  it('still accepts normal bodies', async () => {
    createUser(t.db, { email: 'dana@example.test' });
    const res = await t.request('/api/auth/login', {
      method: 'POST',
      json: { email: 'dana@example.test', password: TEST_PASSWORD },
    });
    expect(res.status).toBe(200);
    // A big-but-legal bulk add (500 comedians) fits.
    const { headers } = await loginAsBooker(t);
    const rows = Array.from({ length: 500 }, (_, i) => ({ name: `Comic Number ${i}`, email: `comic${i}@example.test` }));
    const bulk = await t.request('/api/comedians/bulk', { method: 'POST', headers, json: { rows, dryRun: true } });
    expect(bulk.status).not.toBe(413);
  });
});

describe('rate limit configuration', () => {
  it('gives every app its own limiter with the production defaults under test', () => {
    expect(rateLimiter(t.db).rules).toEqual(DEFAULT_RATE_LIMITS);
    const other = makeTestApp();
    try {
      expect(rateLimiter(other.db)).not.toBe(rateLimiter(t.db));
    } finally {
      other.close();
    }
  });

  it('accepts overrides', async () => {
    const app = createApp({ db: t.db, rateLimits: { loginFailuresPerAccount: { limit: 1, windowMs: 60_000 } } });
    const login = () =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@example.test', password: 'nope-nope' }),
      });
    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(429);
  });
});
