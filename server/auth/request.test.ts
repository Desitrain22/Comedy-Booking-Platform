import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { clientIp, isHttpsRequest, trustProxyHops } from './request';

afterEach(() => {
  delete process.env.TRUST_PROXY;
});

async function probe(url: string, headers: Record<string, string> = {}, env?: unknown) {
  const app = new Hono();
  app.get('*', (c) => c.json({ ip: clientIp(c), https: isHttpsRequest(c) }));
  const res = await app.request(url, { headers }, env);
  return (await res.json()) as { ip: string; https: boolean };
}

/** What @hono/node-server passes as `c.env`. */
const nodeEnv = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

describe('trustProxyHops', () => {
  it('reads TRUST_PROXY', () => {
    expect(trustProxyHops({})).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY: '0' })).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY: 'false' })).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY: '1' })).toBe(1);
    expect(trustProxyHops({ TRUST_PROXY: 'true' })).toBe(1);
    expect(trustProxyHops({ TRUST_PROXY: '2' })).toBe(2);
    expect(trustProxyHops({ TRUST_PROXY: 'banana' })).toBe(0);
  });
});

describe('clientIp', () => {
  it('uses the socket address and ignores X-Forwarded-For by default', async () => {
    expect(await probe('http://x/', { 'x-forwarded-for': '6.6.6.6' }, nodeEnv('::ffff:10.0.0.5'))).toMatchObject({
      ip: '10.0.0.5',
    });
    expect((await probe('http://x/')).ip).toBe('unknown');
  });

  it('with TRUST_PROXY takes the entry the trusted proxy appended (right-most)', async () => {
    process.env.TRUST_PROXY = '1';
    const env = nodeEnv('127.0.0.1');
    expect((await probe('http://x/', { 'x-forwarded-for': '203.0.113.9' }, env)).ip).toBe('203.0.113.9');
    // A client-supplied left-hand value can't choose the key.
    expect((await probe('http://x/', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, env)).ip).toBe('203.0.113.9');
    // No header → the socket.
    expect((await probe('http://x/', {}, env)).ip).toBe('127.0.0.1');

    process.env.TRUST_PROXY = '2'; // CDN → proxy → app
    expect((await probe('http://x/', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }, env)).ip).toBe(
      '203.0.113.9',
    );
  });
});

describe('clientIp for IPv6', () => {
  const ip = async (remoteAddress: string) => (await probe('http://x/', {}, nodeEnv(remoteAddress))).ip;

  it('keys an IPv6 client by its /64, whichever way the address is written', async () => {
    for (const address of [
      '2001:db8:1:2:aaaa:bbbb:cccc:dddd',
      '2001:db8:1:2::1',
      '2001:db8:1:2::',
      '2001:0DB8:0001:0002:0000:0000:0000:0001',
      '2001:db8:1:2:0:0:1.2.3.4',
    ]) {
      expect(await ip(address), address).toBe('2001:db8:1:2::/64');
    }
    expect(await ip('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    // Compressed forms where `::` swallows part of the prefix.
    expect(await ip('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(await ip('2001:db8::1:2:3:4')).toBe('2001:db8:0:0::/64');
    expect(await ip('::1')).toBe('0:0:0:0::/64');
    expect(await ip('::')).toBe('0:0:0:0::/64');
    expect(await ip('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('leaves IPv4 (and IPv4-mapped IPv6) as the plain address', async () => {
    expect(await ip('203.0.113.9')).toBe('203.0.113.9');
    expect(await ip('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(await ip('::FFFF:10.0.0.5')).toBe('10.0.0.5');
  });

  it('applies to X-Forwarded-For with TRUST_PROXY, and leaves non-addresses alone', async () => {
    process.env.TRUST_PROXY = '1';
    const env = nodeEnv('127.0.0.1');
    expect((await probe('http://x/', { 'x-forwarded-for': '2001:db8:1:2:dead:beef::7' }, env)).ip).toBe(
      '2001:db8:1:2::/64',
    );
    expect((await probe('http://x/', { 'x-forwarded-for': 'not-an-ip' }, env)).ip).toBe('not-an-ip');
  });
});

describe('isHttpsRequest', () => {
  it('trusts X-Forwarded-Proto only with TRUST_PROXY', async () => {
    expect((await probe('https://club.example/')).https).toBe(true);
    expect((await probe('http://club.example/', { 'x-forwarded-proto': 'https' })).https).toBe(false);
    process.env.TRUST_PROXY = '1';
    expect((await probe('http://club.example/', { 'x-forwarded-proto': 'https' })).https).toBe(true);
    expect((await probe('http://club.example/', { 'x-forwarded-proto': 'http' })).https).toBe(false);
  });
});
