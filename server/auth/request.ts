/**
 * Facts about the incoming request that depend on how the server is deployed.
 *
 * Behind a reverse proxy (Caddy, nginx, Traefik, a PaaS router…) every request arrives
 * from the proxy's address over plain http. Set `TRUST_PROXY=1` (or the number of proxies
 * in front of the app) so the client IP comes from `X-Forwarded-For` and https from
 * `X-Forwarded-Proto`. Leave it unset when the app is reachable directly: anyone could
 * then send those headers and pick their own IP (and dodge the sign-in rate limits).
 */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Context } from 'hono';

/** Proxies in front of the app whose `X-Forwarded-*` headers we believe (`TRUST_PROXY`). 0 = none. */
export function trustProxyHops(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source.TRUST_PROXY?.trim().toLowerCase();
  if (!raw || ['0', 'false', 'no', 'off'].includes(raw)) return 0;
  if (['true', 'yes', 'on'].includes(raw)) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10) : 0;
}

/** The socket's remote address (Node server), or null (e.g. `app.request()` in tests). */
function socketAddress(c: Context): string | null {
  const bindings = c.env as { incoming?: IncomingMessage; server?: { incoming?: IncomingMessage } } | undefined;
  const incoming = bindings?.server?.incoming ?? bindings?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

/**
 * `2001:db8:1:2:aaaa::1` → `2001:db8:1:2::/64`. One home or one server usually gets a whole
 * /64 and can pick any address in it, so keying single IPv6 addresses would hand one client
 * billions of fresh rate-limit budgets (and let it flood the limiter with keys).
 */
function ipv6Network(ip: string): string {
  let address = ip.split('%')[0]!; // drop a zone (`fe80::1%eth0`)
  // An embedded IPv4 tail (`::1.2.3.4`) is the last two groups.
  if (address.includes('.')) {
    const at = address.lastIndexOf(':') + 1;
    const [a = 0, b = 0, c = 0, d = 0] = address.slice(at).split('.').map(Number);
    address = `${address.slice(0, at)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  // Expand `::` into the zero groups it stands for, then keep the first four.
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * The rate-limit key for an address: `::ffff:1.2.3.4` → `1.2.3.4`, so one client has one key
 * whichever way it connected; other IPv6 addresses → their /64 (see `ipv6Network`).
 */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:') && trimmed.includes('.')) return trimmed.slice(7);
  return isIP(trimmed) === 6 ? ipv6Network(trimmed) : trimmed;
}

/**
 * The client's IP for rate limiting (an IPv6 client is keyed by its /64). With `TRUST_PROXY=N`
 * it's the address N hops from the right of `X-Forwarded-For` (each proxy appends the address
 * it saw, so entries further left are client-supplied and can't be trusted). Falls back to the
 * socket address, then `unknown`.
 */
export function clientIp(c: Context): string {
  const hops = trustProxyHops();
  if (hops > 0) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const ip = forwarded[forwarded.length - hops] ?? forwarded[0];
    if (ip) return normalizeIp(ip);
  }
  const socket = socketAddress(c);
  return socket ? normalizeIp(socket) : 'unknown';
}

/** Did this request reach us (or, with TRUST_PROXY, the proxy in front of us) over https? */
export function isHttpsRequest(c: Context): boolean {
  try {
    if (new URL(c.req.url).protocol === 'https:') return true;
  } catch {
    // fall through
  }
  if (trustProxyHops() === 0) return false;
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return proto === 'https';
}
