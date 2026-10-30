/**
 * The SMTP host guard (hosted mode): mailbox hosts inside our network are refused on save
 * and, after resolving, at send time; single-club mode and the platform sender are exempt.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users, type User } from '../db/schema';
import { updateSettings } from '../lib/settings';
import {
  PLATFORM_SMTP,
  PUBLIC_TEST_ADDRESS,
  captureMail,
  hostedMode,
  resolveSmtpHosts,
  restoreEnv,
  singleClubMode,
} from '../test/emailEnv';
import { latestEmail, loginAsBooker, makeTestApp, readJson, type AuthHeaders, type TestApp } from '../test/helpers';
import { sendEmail, smtpTransportOptions } from './mailer';
import { isBlockedAddress, setSmtpHostLookup, smtpHostNotAllowed, vetSmtpHost } from './smtpHostGuard';

let t: TestApp;
let admin: { user: User; headers: AuthHeaders };
let rich: { user: User; headers: AuthHeaders };

beforeEach(async () => {
  singleClubMode();
  t = makeTestApp();
  admin = await loginAsBooker(t, { role: 'admin', name: 'Ada Admin', email: 'ada@club.test' });
  rich = await loginAsBooker(t, { role: 'booker', name: 'Rich Brooks', email: 'rich@club.test' });
});

afterEach(() => {
  restoreEnv();
  t.close();
});

const message = { to: 'comic@example.test', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', kind: 'availability_request' as const };

/** Records every lookup; resolves like `resolveSmtpHosts`. */
function trackLookups(addresses: Record<string, string[]> = {}): string[] {
  const seen: string[] = [];
  setSmtpHostLookup(async (host) => {
    seen.push(host);
    return (addresses[host] ?? [PUBLIC_TEST_ADDRESS]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
  return seen;
}

function connectCompanyMailbox(host: string) {
  updateSettings(t.db, { smtpHost: host, smtpPort: 587, smtpUser: 'club@club.test', smtpPass: 'club-pass' });
}

function connectBookerMailbox(user: User, host: string) {
  t.db
    .update(users)
    .set({ smtpHost: host, smtpPort: 465, smtpSecure: true, smtpUser: 'rich@richmail.test', smtpPass: 'rich-pass' })
    .where(eq(users.id, user.id))
    .run();
}

describe('blocked addresses', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe', // 169.254.169.254, hex form
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '203.0.113.10', '172.32.0.1', '172.15.255.255', '100.128.0.1', '192.169.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('hosts refused on save', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'mail.localhost',
    'metadata.google.internal',
    'smtp.corp.internal',
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.1.1',
    '0.0.0.0',
    // Shorthands resolvers read as IPs.
    '127.1',
    '2130706433',
    '0x7f000001',
    '010.0.0.1',
  ])('refuses %s', (host) => {
    expect(smtpHostNotAllowed(host)).toBe(true);
  });

  it.each(['smtp.gmail.com', 'smtp.resend.com', 'mail.internal-relay.com', 'localhost.example.com', '8.8.8.8', 'smtp2.example.com', ''])(
    'allows %s',
    (host) => {
      expect(smtpHostNotAllowed(host)).toBe(false);
    },
  );
});

describe('vetSmtpHost', () => {
  it('connects to a vetted address, preferring IPv4', async () => {
    trackLookups({ 'smtp.example.test': ['2001:db8::25', '198.51.100.25'] });
    expect(await vetSmtpHost('smtp.example.test')).toEqual({ address: '198.51.100.25' });
  });

  it('refuses a name with any private address', async () => {
    trackLookups({ 'smtp.sneaky.test': ['198.51.100.25', '10.0.0.7'] });
    expect(await vetSmtpHost('smtp.sneaky.test')).toEqual({
      error: expect.stringContaining('private network address (10.0.0.7)'),
    });
  });

  it('refuses local names without resolving them, and passes on DNS failures', async () => {
    const seen = trackLookups();
    expect(await vetSmtpHost('localhost')).toMatchObject({ error: expect.stringContaining('private network') });
    expect(seen).toEqual([]);
    resolveSmtpHosts({ 'smtp.typo.test': [] });
    expect(await vetSmtpHost('smtp.typo.test')).toEqual({ error: 'getaddrinfo ENOTFOUND smtp.typo.test' });
  });
});

describe('at send time (hosted mode)', () => {
  it('refuses a company mailbox whose name resolves to 127.0.0.1, never connecting', async () => {
    hostedMode(t.db);
    resolveSmtpHosts({ 'smtp.evil.test': ['127.0.0.1'] });
    const sent = captureMail();
    connectCompanyMailbox('smtp.evil.test');
    const result = await sendEmail(t.db, message);
    expect(sent).toHaveLength(0);
    expect(result).toMatchObject({
      status: 'failed',
      error: "Refused to connect to smtp.evil.test: it points to a private network address (127.0.0.1), which isn't allowed",
    });
    expect(latestEmail(t.db)).toMatchObject({ status: 'failed', via: 'company-mailbox' });
  });

  it("refuses a booker's mailbox the same way", async () => {
    hostedMode(t.db);
    resolveSmtpHosts({ 'smtp.rich.test': ['192.168.0.20'] });
    const sent = captureMail();
    updateSettings(t.db, { senderMode: 'booker' });
    connectBookerMailbox(rich.user, 'smtp.rich.test');
    const result = await sendEmail(t.db, { ...message, senderUserId: rich.user.id });
    expect(sent).toHaveLength(0);
    expect(result.error).toContain('(192.168.0.20)');
    expect(latestEmail(t.db)).toMatchObject({ status: 'failed', via: 'booker-mailbox', senderUserId: rich.user.id });
  });

  it('connects to the vetted address, keeping the name for TLS', async () => {
    hostedMode(t.db);
    resolveSmtpHosts({ 'smtp.club.test': ['198.51.100.25'] });
    const sent = captureMail();
    connectCompanyMailbox('smtp.club.test');
    expect((await sendEmail(t.db, message)).status).toBe('sent');
    expect(sent[0]?.server).toMatchObject({ host: 'smtp.club.test', address: '198.51.100.25' });
    expect(smtpTransportOptions(sent[0]!.server)).toMatchObject({ host: '198.51.100.25', servername: 'smtp.club.test' });
  });

  it('the mailbox test says what is wrong', async () => {
    hostedMode(t.db);
    resolveSmtpHosts({ 'smtp.evil.test': ['127.0.0.1'] });
    captureMail();
    await t.request('/api/me/mailbox', {
      method: 'PUT',
      headers: rich.headers,
      json: { smtpHost: 'smtp.evil.test', smtpPort: 587, smtpSecure: false, smtpUser: 'rich@evil.test', smtpPass: 'x' },
    });
    const res = await t.request('/api/me/mailbox/test', { method: 'POST', headers: rich.headers, json: {} });
    expect(res.status).toBe(502);
    const body = await readJson<{ smtpError: string; hint: string }>(res);
    expect(body.smtpError).toContain('private network address (127.0.0.1)');
    expect(body.hint).toContain('points inside a private network');
  });

  it("exempts the platform's own sender", async () => {
    hostedMode(t.db, {}, { smtp: { ...PLATFORM_SMTP, host: '127.0.0.1' } });
    const seen = trackLookups();
    const sent = captureMail();
    expect((await sendEmail(t.db, message)).status).toBe('sent');
    expect(seen).toEqual([]);
    expect(sent[0]?.server).toMatchObject({ host: '127.0.0.1' });
    expect(sent[0]?.server.address).toBeUndefined();
  });

  it('leaves single-club mode alone: a self-hosted club may use its own relay', async () => {
    singleClubMode();
    const seen = trackLookups({ 'relay.lan': ['10.0.0.2'] });
    const sent = captureMail();
    connectCompanyMailbox('127.0.0.1');
    expect((await sendEmail(t.db, message)).status).toBe('sent');
    connectCompanyMailbox('relay.lan');
    expect((await sendEmail(t.db, message)).status).toBe('sent');
    expect(seen).toEqual([]);
    expect(sent.map((m) => [m.server.host, m.server.address])).toEqual([
      ['127.0.0.1', undefined],
      ['relay.lan', undefined],
    ]);
  });
});

describe('on save', () => {
  const mailbox = (smtpHost: string) => ({ smtpHost, smtpPort: 587, smtpSecure: false, smtpUser: 'me@club.test', smtpPass: 'x' });

  it('refuses local and private company mailbox hosts with 400 smtp_host_not_allowed (hosted)', async () => {
    hostedMode(t.db);
    for (const smtpHost of ['127.0.0.1', 'localhost', 'smtp.localhost', 'mail.internal', '10.0.0.5', '169.254.169.254']) {
      const res = await t.request('/api/settings', { method: 'PUT', headers: admin.headers, json: mailbox(smtpHost) });
      expect(res.status, smtpHost).toBe(400);
      expect(await readJson(res), smtpHost).toMatchObject({
        code: 'smtp_host_not_allowed',
        error: expect.stringContaining('private or internal network'),
        issues: [{ path: 'smtpHost' }],
      });
    }
    const ok = await t.request('/api/settings', { method: 'PUT', headers: admin.headers, json: mailbox('smtp.gmail.com') });
    expect(ok.status).toBe(200);
    // Disconnecting (a blank host) is always fine.
    expect((await t.request('/api/settings', { method: 'PUT', headers: admin.headers, json: { smtpHost: '' } })).status).toBe(200);
  });

  it('refuses them for per-booker mailboxes too', async () => {
    hostedMode(t.db);
    for (const smtpHost of ['192.168.1.10', 'localhost', 'metadata.google.internal', '127.1']) {
      const res = await t.request('/api/me/mailbox', { method: 'PUT', headers: rich.headers, json: mailbox(smtpHost) });
      expect(res.status, smtpHost).toBe(400);
      expect(await readJson(res), smtpHost).toMatchObject({ code: 'smtp_host_not_allowed', issues: [{ path: 'smtpHost' }] });
    }
    expect(
      (await t.request('/api/me/mailbox', { method: 'PUT', headers: rich.headers, json: mailbox('smtp.gmail.com') })).status,
    ).toBe(200);
  });

  it('allows any host in single-club mode', async () => {
    expect((await t.request('/api/settings', { method: 'PUT', headers: admin.headers, json: mailbox('127.0.0.1') })).status).toBe(200);
    expect((await t.request('/api/me/mailbox', { method: 'PUT', headers: rich.headers, json: mailbox('localhost') })).status).toBe(200);
  });

  it('is checked before anything is saved', async () => {
    hostedMode(t.db);
    await t.request('/api/settings', { method: 'PUT', headers: admin.headers, json: { ...mailbox('10.0.0.5'), fromName: 'Desk' } });
    await t.request('/api/me/mailbox', { method: 'PUT', headers: rich.headers, json: mailbox('10.0.0.5') });
    expect(t.db.select().from(users).where(eq(users.id, rich.user.id)).get()?.smtpHost).toBe('');
    const settings = await readJson<{ smtpHost: string; fromName: string }>(
      await t.request('/api/settings', { headers: admin.headers }),
    );
    expect(settings).toMatchObject({ smtpHost: '', fromName: '' });
  });
});
