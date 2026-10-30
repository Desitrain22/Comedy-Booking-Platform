/**
 * Hosted mode: SMTP servers that clubs and bookers enter must be on the public internet, so
 * a mailbox form can't be used to make the server connect inside our own network (other
 * services, cloud metadata, the app itself).
 *
 * - On save (`smtpHostNotAllowed`): `localhost`, `*.localhost`, `*.internal`, a literal IP
 *   in a blocked range, or a numeric shorthand like `127.1` (resolvers read it as an IP).
 * - At send time (`vetSmtpHost`): the name is resolved (`dns.lookup`, all addresses) and
 *   refused if any address is in a blocked range; otherwise the connection goes to one of the
 *   vetted addresses (nodemailer gets the IP, with `servername` for TLS), so a DNS answer that
 *   changes between the check and the connection can't slip past it.
 *
 * Blocked ranges: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12, 192.168/16,
 * ::, ::1, fc00::/7, fe80::/10 — and IPv4-mapped IPv6 forms of the IPv4 ones.
 *
 * Single-club mode (a self-hosted club pointing at its own relay is normal) and the
 * platform's own SMTP_* sender are never checked.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addAddress('::1', 'ipv6');
BLOCKED.addSubnet('fc00::', 7, 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');

/** The save-time refusal (400 `smtp_host_not_allowed`). */
export const SMTP_HOST_NOT_ALLOWED_MESSAGE =
  "That server is on a private or internal network, which isn't allowed here. Use your email provider's SMTP server, like smtp.gmail.com.";

/** An address (IPv4 or IPv6, including IPv4-mapped) in a loopback, private, link-local, CGNAT, unique-local or unspecified range. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Whether a host typed into a mailbox form must be refused on save: a local or internal
 * name, a blocked IP literal, or a numeric shorthand (`127.1`, `2130706433`, `0x7f.1`) that
 * resolvers would read as an IP.
 */
export function smtpHostNotAllowed(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (isIP(h)) return isBlockedAddress(h);
  const last = h.split('.').pop() ?? '';
  return /^(\d+|0x[0-9a-f]*)$/.test(last);
}

// ---------------------------------------------------------------------------
// Send time
// ---------------------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type SmtpHostLookup = (host: string) => Promise<ResolvedAddress[]>;

const defaultLookup: SmtpHostLookup = (host) => lookup(host, { all: true });
let hostLookup: SmtpHostLookup = defaultLookup;

/** Tests: replace how SMTP hosts are resolved (pass null to restore `dns.lookup`). */
export function setSmtpHostLookup(fn: SmtpHostLookup | null): void {
  hostLookup = fn ?? defaultLookup;
}

/** The send-time refusal; `smtpErrorHint` recognises it. */
export function privateAddressError(host: string, address: string): string {
  return `Refused to connect to ${host}: it points to a private network address (${address}), which isn't allowed`;
}

/**
 * Resolve an SMTP host and check every address. `{ address }` is the one to connect to (an
 * IPv4 one when there is one), or `{ error }` when the host is refused or doesn't resolve.
 */
export async function vetSmtpHost(host: string): Promise<{ address: string } | { error: string }> {
  if (smtpHostNotAllowed(host)) return { error: privateAddressError(host, host) };
  let addresses: ResolvedAddress[];
  try {
    addresses = await hostLookup(host);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (addresses.length === 0) return { error: `getaddrinfo ENOTFOUND ${host}` };
  const blocked = addresses.find((a) => isBlockedAddress(a.address));
  if (blocked) return { error: privateAddressError(host, blocked.address) };
  return { address: (addresses.find((a) => a.family === 4) ?? addresses[0]!).address };
}
