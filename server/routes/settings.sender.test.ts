/**
 * Settings API for who emails come from (hosted MVP spec §5): senderMode, the previews,
 * the platform sender in hosted mode, the locked app URL, passwords encrypted on write,
 * and the email log's `via` / sender.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmailLogDetail, EmailLogItem, SettingsDto } from '../../shared/api/settings';
import type { DashboardResponse } from '../../shared/api/dashboard';
import type { OnboardingResponse } from '../../shared/api/onboarding';
import type { ApiErrorBody } from '../../shared/types';
import { emailLog, type User } from '../db/schema';
import { decryptSecret, isEncryptedSecret } from '../lib/secrets';
import { getSettings, updateSettings } from '../lib/settings';
import {
  PLATFORM_SMTP,
  TEST_APP_SECRET,
  captureMail,
  hostedMode,
  restoreEnv,
  setEnv,
  singleClubMode,
} from '../test/emailEnv';
import {
  TEST_APP_URL,
  latestEmail,
  loginAsBooker,
  makeTestApp,
  readJson,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';

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

async function getDto(headers: AuthHeaders = admin.headers): Promise<SettingsDto> {
  const res = await t.request('/api/settings', { headers });
  expect(res.status).toBe(200);
  return readJson<SettingsDto>(res);
}

function put(json: unknown, headers: AuthHeaders = admin.headers) {
  return t.request('/api/settings', { method: 'PUT', headers, json });
}

describe('senderMode', () => {
  it('defaults to company; admins switch it', async () => {
    expect((await getDto()).senderMode).toBe('company');
    const res = await put({ senderMode: 'booker' });
    expect(res.status).toBe(200);
    expect((await readJson<SettingsDto>(res)).senderMode).toBe('booker');
    expect(getSettings(t.db).senderMode).toBe('booker');
    expect((await getDto(rich.headers)).senderMode).toBe('booker');
  });

  it('is admin-only like the other email settings (sending it back unchanged is fine)', async () => {
    const denied = await put({ senderMode: 'booker' }, rich.headers);
    expect(denied.status).toBe(403);
    expect(await readJson(denied)).toMatchObject({ code: 'admin_only', fields: ['senderMode'] });
    expect(getSettings(t.db).senderMode).toBe('company');
    expect((await put({ senderMode: 'company', clubName: 'Renamed' }, rich.headers)).status).toBe(200);
  });

  it('accepts only company or booker', async () => {
    for (const senderMode of ['everyone', '', null, 1]) {
      const res = await put({ senderMode });
      expect(res.status, JSON.stringify(senderMode)).toBe(400);
      expect(await readJson(res)).toMatchObject({ code: 'validation_error', issues: [{ path: 'senderMode' }] });
    }
  });
});

describe('what comedians see', () => {
  it('single club, nothing configured: no previews, no platform sender, the app URL editable', async () => {
    expect(await getDto()).toMatchObject({
      emailConfigured: false,
      emailSource: null,
      platformSender: null,
      senderPreview: null,
      bookerSenderPreview: null,
      appUrlLocked: false,
    });
  });

  it('previews the company mailbox, and the signed-in booker as the sender', async () => {
    updateSettings(t.db, {
      smtpHost: 'smtp.club.test',
      smtpUser: 'bookings@club.test',
      smtpPass: 'x',
      replyTo: 'desk@club.test',
    });
    expect(await getDto(rich.headers)).toMatchObject({
      emailSource: 'settings',
      platformSender: null,
      senderPreview: {
        via: 'company-mailbox',
        fromName: 'Test Comedy Club',
        fromEmail: 'bookings@club.test',
        replyTo: 'desk@club.test',
      },
      bookerSenderPreview: {
        via: 'company-mailbox',
        fromName: 'Rich Brooks · Test Comedy Club',
        fromEmail: 'bookings@club.test',
        replyTo: 'rich@club.test',
      },
    });
  });

  it('hosted mode: emails already go out through the platform sender, no setup', async () => {
    hostedMode();
    const dto = await getDto();
    expect(dto).toMatchObject({
      emailConfigured: true,
      emailSource: 'platform',
      emailHost: PLATFORM_SMTP.host,
      emailFrom: '"Test Comedy Club" <bookings@mail.platform.test>',
      platformSender: { fromEmail: 'bookings@mail.platform.test' },
      senderPreview: {
        via: 'platform',
        fromName: 'Test Comedy Club',
        fromEmail: 'bookings@mail.platform.test',
        replyTo: 'ada@club.test',
      },
      bookerSenderPreview: { fromName: 'Ada Admin · Test Comedy Club', replyTo: 'ada@club.test' },
      appUrlLocked: true,
    });

    // The guide and dashboard see email as connected.
    const onboarding = await readJson<OnboardingResponse>(await t.request('/api/onboarding', { headers: admin.headers }));
    expect(onboarding.emailConfigured).toBe(true);
    const dashboard = await readJson<DashboardResponse>(await t.request('/api/dashboard', { headers: admin.headers }));
    expect(dashboard.emailConfigured).toBe(true);
  });

  it("the company email status ignores a booker's own mailbox", async () => {
    hostedMode();
    t.db.insert(emailLog).values({ toEmail: 'a@x.test', subject: 'Company', kind: 'test', status: 'sent', via: 'platform' }).run();
    t.db
      .insert(emailLog)
      .values({ toEmail: 'b@x.test', subject: 'Mine', kind: 'test', status: 'failed', error: 'bad', via: 'booker-mailbox' })
      .run();
    expect((await getDto()).lastEmail).toMatchObject({ status: 'sent', error: null });
  });
});

describe('the app URL in hosted mode', () => {
  // (http app URLs keep the tests' plain session cookies: over https they're `__Host-` cookies.)
  it('rejects a change with 400 app_url_locked; the same value is fine', async () => {
    hostedMode();
    updateSettings(t.db, { appUrl: 'http://broadway.comedy.test' });
    for (const appUrl of ['https://evil.example', '']) {
      const res = await put({ appUrl, clubName: 'Renamed' });
      expect(res.status, appUrl).toBe(400);
      const body = await readJson<ApiErrorBody>(res);
      expect(body.code).toBe('app_url_locked');
    }
    // Bookers get the same answer.
    expect(await readJson(await put({ appUrl: 'https://evil.example' }, rich.headers))).toMatchObject({ code: 'app_url_locked' });
    expect(getSettings(t.db)).toMatchObject({ appUrl: 'http://broadway.comedy.test', clubName: 'Test Comedy Club' });

    // Unchanged (after normalising) or omitted: saved as usual.
    expect((await put({ appUrl: 'http://broadway.comedy.test/', clubName: 'Renamed' })).status).toBe(200);
    expect((await put({ timezone: 'America/Chicago' })).status).toBe(200);
    expect(getSettings(t.db)).toMatchObject({ clubName: 'Renamed', timezone: 'America/Chicago' });
  });

  it('stays editable in single-club mode', async () => {
    const res = await put({ appUrl: 'http://booking.laughtrack.test' });
    expect(res.status).toBe(200);
    expect(getSettings(t.db).appUrl).toBe('http://booking.laughtrack.test');
    expect((await put({ appUrl: TEST_APP_URL })).status).toBe(200);
  });
});

describe('company mailbox password at rest', () => {
  it('is encrypted on save when APP_SECRET is set, and still sends', async () => {
    setEnv({ appSecret: TEST_APP_SECRET });
    const sent = captureMail();
    const res = await put({
      smtpHost: 'smtp.club.test',
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: 'bookings@club.test',
      smtpPass: 'club-secret',
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const saved = getSettings(t.db).smtpPass;
    expect(isEncryptedSecret(saved)).toBe(true);
    expect(decryptSecret(saved, TEST_APP_SECRET)).toBe('club-secret');
    expect(raw).not.toContain('club-secret');
    expect(raw).not.toContain(saved);
    expect(JSON.parse(raw)).toMatchObject({ smtpPassSet: true });

    // Saving other fields keeps it; the test email logs in with the plaintext.
    expect((await put({ fromName: 'Desk', smtpPass: '' })).status).toBe(200);
    expect(getSettings(t.db).smtpPass).toBe(saved);
    const test = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(test.status).toBe(200);
    expect(sent[0]?.server).toMatchObject({ host: 'smtp.club.test', pass: 'club-secret' });
  });
});

describe('the company test email in hosted mode', () => {
  it('goes out through the platform sender and counts toward the daily cap', async () => {
    hostedMode({ dailyEmailCap: 1 });
    const sent = captureMail();
    const first = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(first.status).toBe(200);
    expect(sent[0]).toMatchObject({ from: '"Test Comedy Club" <bookings@mail.platform.test>', server: { host: 'smtp.platform.test' } });

    const capped = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(capped.status).toBe(502);
    expect(await readJson(capped)).toMatchObject({
      code: 'email_failed',
      smtpError: 'Daily email limit reached (1 per day) — contact support',
      hint: expect.stringContaining('starts again tomorrow'),
    });
    expect((await getDto()).lastEmail).toMatchObject({ status: 'failed', error: expect.stringContaining('Daily email limit') });
  });

  it("explains a platform failure as the platform's, not the club's SMTP settings", async () => {
    hostedMode();
    captureMail(async () => {
      throw new Error('Invalid login: 535 Authentication failed');
    });
    const res = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(res.status).toBe(502);
    const body = await readJson<{ hint: string }>(res);
    expect(body.hint).toContain("nothing to fix in your settings");
    expect(body.hint).not.toContain('Resend');
  });
});

describe('email log', () => {
  it('shows how each email went out and the booker it was sent for', async () => {
    hostedMode();
    captureMail();
    updateSettings(t.db, { senderMode: 'booker' });
    await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    await t.request('/api/availability-requests', {
      method: 'POST',
      headers: rich.headers,
      json: { month: '2026-12', audience: 'all' },
    }); // nobody to send to: 409, nothing logged
    t.db
      .insert(emailLog)
      .values({ toEmail: 'old@x.test', subject: 'Before via existed', kind: 'confirmation', status: 'sent' })
      .run();
    t.db
      .insert(emailLog)
      .values({
        toEmail: 'john@x.test',
        subject: 'Confirm',
        kind: 'confirmation',
        status: 'sent',
        via: 'booker-mailbox',
        senderUserId: rich.user.id,
      })
      .run();

    const items = await readJson<EmailLogItem[]>(await t.request('/api/email-log', { headers: admin.headers }));
    expect(items.map((i) => [i.subject, i.via, i.senderName])).toEqual([
      ['Confirm', 'booker-mailbox', 'Rich Brooks'],
      ['Before via existed', null, null],
      ['Test email from Test Comedy Club', 'platform', null],
    ]);
    const detail = await readJson<EmailLogDetail>(
      await t.request(`/api/email-log/${latestEmail(t.db)!.id}`, { headers: admin.headers }),
    );
    expect(detail).toMatchObject({ via: 'booker-mailbox', senderName: 'Rich Brooks', subject: 'Confirm' });
  });
});
