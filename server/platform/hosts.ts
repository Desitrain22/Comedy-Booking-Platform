/**
 * Host names in hosted mode (hosted MVP spec §3):
 *
 *   <domain>, www.<domain>   the platform site (landing, sign-up, find my club, owner console)
 *   <slug>.<domain>          that club's app
 *   anything else            no club (the API answers 404 `club_not_found`)
 *
 * Hosts compare case-insensitively and include the port (`localhost:5173` and
 * `broadway.localhost:5173` in dev). A default port the browser left out (`:443` / `:80`)
 * is ignored when the platform URL has none.
 */
import type { HostedEnv } from '../env';

export type HostMatch =
  | { kind: 'platform' }
  | { kind: 'club'; slug: string }
  /** Not ours: a bare IP, the hosting provider's own name, a deeper subdomain… */
  | { kind: 'other' };

/** `Host` → lowercased, trailing dot dropped, default port dropped when the platform has none. */
export function normalizeHost(host: string, platformHost: string): string {
  let h = host.trim().toLowerCase();
  const colon = h.lastIndexOf(':');
  let port = '';
  if (colon > h.lastIndexOf(']')) {
    port = h.slice(colon);
    h = h.slice(0, colon);
  }
  h = h.replace(/\.$/, '');
  if ((port === ':80' || port === ':443') && !platformHost.includes(':')) port = '';
  return `${h}${port}`;
}

/** Which site a request host belongs to. */
export function matchHost(hosted: Pick<HostedEnv, 'platformHost'>, host: string | null | undefined): HostMatch {
  if (!host) return { kind: 'other' };
  const platformHost = hosted.platformHost.toLowerCase();
  const h = normalizeHost(host, platformHost);
  if (h === platformHost || h === `www.${platformHost}`) return { kind: 'platform' };
  const suffix = `.${platformHost}`;
  if (!h.endsWith(suffix)) return { kind: 'other' };
  const label = h.slice(0, -suffix.length);
  // One label only: `a.b.<domain>` is not a club.
  if (!label || label.includes('.')) return { kind: 'other' };
  return { kind: 'club', slug: label };
}

/** The host of a request URL (`new URL(c.req.url).host`), or null. */
export function requestHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** `<protocol>//<slug>.<platformHost>`, e.g. `https://broadway.comedybook.app`. */
export function clubUrl(hosted: Pick<HostedEnv, 'protocol' | 'platformHost'>, slug: string): string {
  return `${hosted.protocol}//${slug}.${hosted.platformHost}`;
}

/** `broadway.comedybook.app` (no protocol), for display. */
export function clubHost(hosted: Pick<HostedEnv, 'platformHost'>, slug: string): string {
  return `${slug}.${hosted.platformHost}`;
}
