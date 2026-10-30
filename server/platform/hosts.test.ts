import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, slugSchema, suggestSlug } from '../../shared/api/platform';
import { readEnv } from '../env';
import { clubHost, clubUrl, matchHost, normalizeHost, requestHost } from './hosts';

const prod = { platformHost: 'comedybook.app', protocol: 'https:' as const };
const dev = { platformHost: 'localhost:5173', protocol: 'http:' as const };

describe('matchHost', () => {
  it('knows the platform host and www.', () => {
    expect(matchHost(prod, 'comedybook.app')).toEqual({ kind: 'platform' });
    expect(matchHost(prod, 'www.comedybook.app')).toEqual({ kind: 'platform' });
    expect(matchHost(dev, 'localhost:5173')).toEqual({ kind: 'platform' });
    expect(matchHost(dev, 'www.localhost:5173')).toEqual({ kind: 'platform' });
  });

  it('reads a club slug from one subdomain label', () => {
    expect(matchHost(prod, 'broadway.comedybook.app')).toEqual({ kind: 'club', slug: 'broadway' });
    expect(matchHost(dev, 'broadway.localhost:5173')).toEqual({ kind: 'club', slug: 'broadway' });
  });

  it('compares case-insensitively and ignores a trailing dot', () => {
    expect(matchHost(prod, 'BroadWay.ComedyBook.APP')).toEqual({ kind: 'club', slug: 'broadway' });
    expect(matchHost(prod, 'comedybook.app.')).toEqual({ kind: 'platform' });
  });

  it('includes the port', () => {
    expect(matchHost(dev, 'broadway.localhost:3000')).toEqual({ kind: 'other' });
    expect(matchHost(dev, 'localhost')).toEqual({ kind: 'other' });
    expect(matchHost(dev, 'broadway.localhost')).toEqual({ kind: 'other' });
    // A default port the browser may spell out is the same host when the platform has none.
    expect(matchHost(prod, 'broadway.comedybook.app:443')).toEqual({ kind: 'club', slug: 'broadway' });
    expect(matchHost(prod, 'comedybook.app:80')).toEqual({ kind: 'platform' });
    expect(matchHost(prod, 'comedybook.app:8080')).toEqual({ kind: 'other' });
  });

  it('treats anything else as not ours', () => {
    expect(matchHost(prod, undefined)).toEqual({ kind: 'other' });
    expect(matchHost(prod, '')).toEqual({ kind: 'other' });
    expect(matchHost(prod, 'evil.com')).toEqual({ kind: 'other' });
    expect(matchHost(prod, 'notcomedybook.app')).toEqual({ kind: 'other' });
    expect(matchHost(prod, 'a.b.comedybook.app')).toEqual({ kind: 'other' });
    expect(matchHost(prod, '.comedybook.app')).toEqual({ kind: 'other' });
    expect(matchHost(prod, '10.0.0.7:3000')).toEqual({ kind: 'other' });
    expect(matchHost(prod, '[::1]:3000')).toEqual({ kind: 'other' });
  });

  it('normalizes hosts', () => {
    expect(normalizeHost('Example.COM:443', 'example.com')).toBe('example.com');
    expect(normalizeHost('example.com:443', 'example.com:8443')).toBe('example.com:443');
    expect(normalizeHost('[::1]', 'example.com')).toBe('[::1]');
    expect(requestHost('http://Broadway.localhost:3000/api/x')).toBe('broadway.localhost:3000');
    expect(requestHost('not a url')).toBeNull();
  });

  it('builds club URLs', () => {
    expect(clubUrl(prod, 'broadway')).toBe('https://broadway.comedybook.app');
    expect(clubUrl(dev, 'broadway')).toBe('http://broadway.localhost:5173');
    expect(clubHost(prod, 'broadway')).toBe('broadway.comedybook.app');
  });

  it('agrees with how env.ts reads PLATFORM_URL', () => {
    const hosted = readEnv({ PLATFORM_URL: 'HTTPS://ComedyBook.app/' }).hosted!;
    expect(hosted).toMatchObject({ platformUrl: 'https://comedybook.app', platformHost: 'comedybook.app' });
    expect(matchHost(hosted, 'broadway.comedybook.app')).toEqual({ kind: 'club', slug: 'broadway' });
    expect(readEnv({}).hosted).toBeNull();
  });
});

describe('slugs', () => {
  const ok = (s: string) => slugSchema.safeParse(s).success;

  it('allows 3–30 of a-z 0-9 - with no hyphen at either end', () => {
    expect(ok('abc')).toBe(true);
    expect(ok('broadway-comedy-2')).toBe(true);
    expect(ok('a'.repeat(30))).toBe(true);
    expect(ok('ab')).toBe(false);
    expect(ok('a'.repeat(31))).toBe(false);
    expect(ok('-broadway')).toBe(false);
    expect(ok('broadway-')).toBe(false);
    expect(ok('broad_way')).toBe(false);
    expect(ok('broad way')).toBe(false);
    expect(ok('bröadway')).toBe(false);
  });

  it('lowercases and trims', () => {
    expect(slugSchema.parse('  BroadWay ')).toBe('broadway');
  });

  it('refuses reserved names', () => {
    for (const reserved of ['www', 'admin', 'api', 'mail', 'support', 'signup', 'login', 'staging', 'test']) {
      expect(RESERVED_SLUGS).toContain(reserved);
      const result = slugSchema.safeParse(reserved);
      expect(result.success, reserved).toBe(false);
    }
    expect(slugSchema.safeParse('admin').error?.issues[0]?.message).toBe('That address is reserved');
  });

  it('suggests a slug from a company name', () => {
    expect(suggestSlug('Broadway Comedy Club!')).toBe('broadway-comedy-club');
    expect(suggestSlug('  Café Olé & Friends ')).toBe('cafe-ole-and-friends');
    expect(suggestSlug('The '.repeat(20)).length).toBeLessThanOrEqual(30);
    expect(suggestSlug('The '.repeat(20))).not.toMatch(/-$/);
  });
});
