import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxDto, TestEmailResponse, UpdateMailboxInput } from '../../shared/api/settings';
import type { ApiErrorBody } from '../../shared/types';
import { users, type User } from '../db/schema';
import { TEST_EMAIL_TIMEOUT_MS } from '../email/testEmail';
import { decryptSecret, isEncryptedSecret } from '../lib/secrets';
import { updateSettings } from '../lib/settings';
import { TEST_APP_SECRET, captureMail, hostedMode, restoreEnv, setEnv, singleClubMode } from '../test/emailEnv';
import {
  createComedian,
  latestEmail,
  loginAsBooker,
  loginAsComedian,
  makeTestApp,
  readJson,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

let t: TestApp;
let rich: { user: User; headers: AuthHeaders };
let eric: { user: User; headers: AuthHeaders };
let admin: { user: User; headers: AuthHeaders };

beforeEach(async () => {
  singleClubMode();
  t = makeTestApp();
  admin = await loginAsBooker(t, { role: 'admin', name: 'Ada Admin', email: 'ada@club.test' });
  rich = await loginAsBooker(t, { role: 'booker', name: 'Rich Brooks', email: 'rich@club.test' });
  eric = await loginAsBooker(t, { role: 'booker', name: 'Eric Hanson', email: 'eric@club.test' });
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv();
  t.close();
});

const RICH_BOX: UpdateMailboxInput = {
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: 'rich.brooks@gmail.com',
  smtpPass: 'rich-app-password',
};

function put(json: unknown, headers: AuthHeaders = rich.headers) {
  return t.request('/api/me/mailbox', { method: 'PUT', headers, json });
}

async function getMailbox(headers: AuthHeaders = rich.headers): Promise<MailboxDto> {
  const res = await t.request('/api/me/mailbox', { headers });
  expect(res.status).toBe(200);
  return readJson<MailboxDto>(res);
}

function stored(user: User): User {
  return t.db.select().from(users).where(eq(users.id, user.id)).get()!;
}

describe('auth', () => {
  it('needs a signed-in booker for every mailbox route', async () => {
    const comedian = createComedian(t.db);
    const { headers: comedianHeaders } = await loginAsComedian(t, comedian.id);
    for (const [method, url] of [
      ['GET', '/api/me/mailbox'],
      ['PUT', '/api/me/mailbox'],
      ['DELETE', '/api/me/mailbox'],
      ['POST', '/api/me/mailbox/test'],
    ] as const) {
      const json = method === 'PUT' ? RICH_BOX : method === 'POST' ? {} : undefined;
      expect((await t.request(url, { method, json })).status, `anonymous ${method} ${url}`).toBe(401);
      expect((await t.request(url, { method, json, headers: comedianHeaders })).status, `comedian ${method} ${url}`).toBe(401);
    }
  });
});

describe('GET/PUT/DELETE /api/me/mailbox', () => {
  it('starts disconnected', async () => {
    expect(await getMailbox()).toEqual({
      connected: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpPassSet: false,
      smtpFromEmail: '',
      senderMode: 'company',
      preview: null,
      lastEmail: null,
    });
  });

  it('connects a mailbox, and never returns the password', async () => {
    const res = await put(RICH_BOX);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('rich-app-password');
    expect(JSON.parse(raw)).toEqual({
      connected: true,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: 'rich.brooks@gmail.com',
      smtpPassSet: true,
      smtpFromEmail: '',
      senderMode: 'company',
      preview: {
        via: 'booker-mailbox',
        fromName: 'Rich Brooks · Test Comedy Club',
        fromEmail: 'rich.brooks@gmail.com',
        replyTo: 'rich@club.test',
      },
      lastEmail: null,
    });
    expect(await (await t.request('/api/me/mailbox', { headers: rich.headers })).text()).not.toContain('rich-app-password');
    expect(stored(rich.user).smtpPass).toBe('rich-app-password'); // no APP_SECRET: plaintext, as before

    updateSettings(t.db, { senderMode: 'booker' });
    expect((await getMailbox()).senderMode).toBe('booker');
  });

  it('encrypts the password at rest when APP_SECRET is set', async () => {
    setEnv({ appSecret: TEST_APP_SECRET });
    expect((await put(RICH_BOX)).status).toBe(200);
    const saved = stored(rich.user).smtpPass;
    expect(isEncryptedSecret(saved)).toBe(true);
    expect(saved).not.toContain('rich-app-password');
    expect(decryptSecret(saved, TEST_APP_SECRET)).toBe('rich-app-password');
  });

  it('keeps the saved password when blank, unless the server or login changes; replaces and clears it', async () => {
    await put(RICH_BOX);
    expect((await put({ ...RICH_BOX, smtpPass: '' })).status).toBe(200);
    expect(stored(rich.user).smtpPass).toBe('rich-app-password');
    expect((await put({ ...RICH_BOX, smtpPass: undefined, smtpFromEmail: 'rich@club.test' })).status).toBe(200);
    expect(stored(rich.user)).toMatchObject({ smtpPass: 'rich-app-password', smtpFromEmail: 'rich@club.test' });

    for (const change of [{ smtpHost: 'smtp.other.test' }, { smtpPort: 587 }, { smtpSecure: false }, { smtpUser: 'new@gmail.com' }]) {
      await put(RICH_BOX);
      const res = await put({ ...RICH_BOX, ...change, smtpPass: '' });
      expect(res.status, JSON.stringify(change)).toBe(200);
      expect((await readJson<MailboxDto>(res)).smtpPassSet, JSON.stringify(change)).toBe(false);
    }

    expect((await put({ ...RICH_BOX, smtpPass: 'new-one' })).status).toBe(200);
    expect(stored(rich.user).smtpPass).toBe('new-one');
    const cleared = await readJson<MailboxDto>(await put({ ...RICH_BOX, smtpPass: 'ignored', clearSmtpPass: true }));
    expect(cleared.smtpPassSet).toBe(false);
  });

  it('validates the mailbox and needs an email address to send from', async () => {
    for (const [json, field] of [
      [{ ...RICH_BOX, smtpHost: '' }, 'smtpHost'],
      [{ ...RICH_BOX, smtpHost: 'https://smtp.gmail.com' }, 'smtpHost'],
      [{ ...RICH_BOX, smtpPort: 0 }, 'smtpPort'],
      [{ ...RICH_BOX, smtpSecure: 'yes' }, 'smtpSecure'],
      [{ ...RICH_BOX, smtpFromEmail: 'nope' }, 'smtpFromEmail'],
    ] as const) {
      const res = await put(json);
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error', issues: [{ path: field }] });
    }
    const resend = await put({ smtpHost: 'smtp.resend.com', smtpPort: 465, smtpSecure: true, smtpUser: 'resend', smtpPass: 're_1' });
    expect(resend.status).toBe(400);
    expect(await readJson(resend)).toMatchObject({ code: 'from_email_required', issues: [{ path: 'smtpFromEmail' }] });
    expect(stored(rich.user).smtpHost).toBe('');

    const ok = await put({ smtpHost: 'smtp.resend.com', smtpPort: 465, smtpSecure: true, smtpUser: 'resend', smtpPass: 're_1', smtpFromEmail: 'Rich@BwayGroup.test' });
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({ smtpFromEmail: 'rich@bwaygroup.test', preview: { fromEmail: 'rich@bwaygroup.test' } });
  });

  it('disconnects', async () => {
    await put({ ...RICH_BOX, smtpFromEmail: 'rich@club.test' });
    const res = await t.request('/api/me/mailbox', { method: 'DELETE', headers: rich.headers });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ connected: false, smtpHost: '', smtpUser: '', smtpPassSet: false, smtpFromEmail: '' });
    expect(stored(rich.user)).toMatchObject({ smtpHost: '', smtpPass: '', smtpUser: '', smtpFromEmail: '' });
  });

  it("is each booker's own: nobody else sees or changes it, admins included", async () => {
    await put(RICH_BOX);
    await put({ ...RICH_BOX, smtpUser: 'eric.h@gmail.com', smtpPass: 'eric-secret' }, eric.headers);

    expect(await getMailbox()).toMatchObject({ smtpUser: 'rich.brooks@gmail.com' });
    expect(await getMailbox(eric.headers)).toMatchObject({ smtpUser: 'eric.h@gmail.com' });
    // The admin sees only their own (empty) mailbox…
    const adminView = await t.request('/api/me/mailbox', { headers: admin.headers });
    const adminRaw = await adminView.text();
    expect(JSON.parse(adminRaw)).toMatchObject({ connected: false });
    // …and nothing about anyone's mailbox comes back from the bookers list or settings.
    for (const url of ['/api/users', '/api/settings', '/api/auth/me']) {
      const raw = await (await t.request(url, { headers: admin.headers })).text();
      for (const secret of ['rich-app-password', 'eric-secret', 'rich.brooks@gmail.com', 'eric.h@gmail.com']) {
        expect(raw, `${url} leaks ${secret}`).not.toContain(secret);
      }
      expect(adminRaw).not.toContain('rich-app-password');
    }

    // Disconnecting your own leaves others' alone.
    await t.request('/api/me/mailbox', { method: 'DELETE', headers: eric.headers });
    expect(stored(rich.user)).toMatchObject({ smtpHost: 'smtp.gmail.com', smtpPass: 'rich-app-password' });
  });
});

describe('POST /api/me/mailbox/test', () => {
  it('needs a connected mailbox', async () => {
    const res = await t.request('/api/me/mailbox/test', { method: 'POST', headers: rich.headers, json: {} });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: 'mailbox_not_connected' });
  });

  it('sends the test email to yourself through your own mailbox, whatever the sender mode', async () => {
    hostedMode(); // a platform sender and company mode: the test still uses Rich's mailbox
    const sent = captureMail();
    await put(RICH_BOX);
    const res = await t.request('/api/me/mailbox/test', { method: 'POST', headers: rich.headers, json: {} });
    expect(res.status).toBe(200);
    const body = await readJson<TestEmailResponse>(res);
    expect(body).toMatchObject({ status: 'sent', to: 'rich@club.test' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'rich@club.test',
      from: '"Rich Brooks · Test Comedy Club" <rich.brooks@gmail.com>',
      replyTo: 'rich@club.test',
      subject: 'Test email from Test Comedy Club',
      server: { host: 'smtp.gmail.com', user: 'rich.brooks@gmail.com', pass: 'rich-app-password' },
    });
    expect(latestEmail(t.db)).toMatchObject({
      id: body.logId,
      kind: 'test',
      status: 'sent',
      via: 'booker-mailbox',
      senderUserId: rich.user.id,
    });
    expect(latestEmail(t.db)?.bodyText).toContain('sent as you');
    expect((await getMailbox()).lastEmail).toMatchObject({ id: body.logId, status: 'sent' });
    // Eric hasn't used a mailbox.
    expect((await getMailbox(eric.headers)).lastEmail).toBeNull();
  });

  it('surfaces the SMTP error with a hint', async () => {
    captureMail(async () => {
      throw new Error('Invalid login: 535-5.7.8 Username and Password not accepted.');
    });
    await put(RICH_BOX);
    const res = await t.request('/api/me/mailbox/test', { method: 'POST', headers: rich.headers, json: {} });
    expect(res.status).toBe(502);
    const body = await readJson<ApiErrorBody & { smtpError: string; hint: string; logId: number }>(res);
    expect(body).toMatchObject({ code: 'email_failed', smtpError: expect.stringContaining('535') });
    expect(body.hint).toContain('App Password');
    expect(latestEmail(t.db)).toMatchObject({ id: body.logId, status: 'failed', via: 'booker-mailbox' });
    expect((await getMailbox()).lastEmail).toMatchObject({ status: 'failed', error: expect.stringContaining('535') });
  });

  it('gives up with 504 when the server never answers', async () => {
    captureMail(() => new Promise(() => undefined));
    await put(RICH_BOX);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = t.request('/api/me/mailbox/test', { method: 'POST', headers: rich.headers, json: {} });
    let done = false;
    void pending.finally(() => (done = true));
    for (let i = 0; i < 40 && !done; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(TEST_EMAIL_TIMEOUT_MS / 10);
    }
    const res = await pending;
    expect(res.status).toBe(504);
    expect(await readJson(res)).toMatchObject({ code: 'email_timeout', error: expect.stringContaining('smtp.gmail.com:465') });
  });

  it('is not held back by the daily cap (a mailbox you connect yourself)', async () => {
    hostedMode({ dailyEmailCap: 0 });
    captureMail();
    await put(RICH_BOX);
    const res = await t.request('/api/me/mailbox/test', { method: 'POST', headers: rich.headers, json: {} });
    expect(res.status).toBe(200);
  });
});
