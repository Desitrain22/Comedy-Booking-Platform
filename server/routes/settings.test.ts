import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { SendMailOptions, Transporter } from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BookerUserDto,
  EmailLogDetail,
  EmailLogItem,
  InviteResponse,
  SettingsDto,
  TestEmailResponse,
} from '../../shared/api/settings';
import type { ApiErrorBody, MeResponse } from '../../shared/types';
import { createInvite } from '../auth/invites';
import { addDays, weekStartOf } from '../../shared/time';
import { jobRuns, notes, sessions, users } from '../db/schema';
import { setTransportFactory } from '../email/mailer';
import { clubToday, getSettings, updateSettings } from '../lib/settings';
import { catchUpJobKey, confirmationsJobKey } from '../services/scheduler';
import {
  TEST_APP_URL,
  createComedian,
  createNote,
  createUser,
  emailsTo,
  latestEmail,
  loginAsBooker,
  loginAsComedian,
  makeTestApp,
  readJson,
  type AuthHeaders,
  type TestApp,
} from '../test/helpers';
import { TEST_EMAIL_TIMEOUT_MS, smtpErrorHint } from './settings';

let t: TestApp;
let admin: { user: { id: number; email: string; name: string }; headers: AuthHeaders };

beforeEach(async () => {
  t = makeTestApp();
  admin = await loginAsBooker(t, { role: 'admin', name: 'Ada Admin', email: 'ada@example.test' });
});

afterEach(() => {
  setTransportFactory(null);
  vi.useRealTimers();
  t.close();
});

type SendMail = Pick<Transporter, 'sendMail'>['sendMail'];

/** Route every SMTP send through `impl` instead of the network. */
function fakeTransport(impl: (mail: SendMailOptions) => Promise<unknown>): void {
  setTransportFactory(() => ({ sendMail: impl as unknown as SendMail }));
}

function configureSmtp(host = 'smtp.example.test') {
  updateSettings(t.db, {
    smtpHost: host,
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: 'mailer@example.test',
    smtpPass: 'hunter2-secret',
  });
}

async function getSettingsDto(headers: AuthHeaders = admin.headers): Promise<SettingsDto> {
  const res = await t.request('/api/settings', { headers });
  expect(res.status).toBe(200);
  return readJson<SettingsDto>(res);
}

function put(json: unknown, headers: AuthHeaders = admin.headers) {
  return t.request('/api/settings', { method: 'PUT', headers, json });
}

// ---------------------------------------------------------------------------

describe('guards', () => {
  it('requires a booker for settings and the email log', async () => {
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['POST', '/api/settings/test-email'],
      ['GET', '/api/email-log'],
      ['GET', '/api/email-log/1'],
    ] as const) {
      const res = await t.request(url, { method, json: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${url}`).toBe(401);
    }

    // A comedian session is not a booker session.
    const comedian = createComedian(t.db);
    const { headers } = await loginAsComedian(t, comedian.id);
    expect((await t.request('/api/settings', { headers })).status).toBe(401);
  });

  it('lets any booker use settings, but only admins read the email log, manage bookers and backups', async () => {
    const { headers } = await loginAsBooker(t, { role: 'booker' });
    expect((await t.request('/api/settings', { headers })).status).toBe(200);
    expect((await put({ clubName: 'Renamed' }, headers)).status).toBe(200);
    expect((await t.request('/api/settings/test-email', { method: 'POST', headers, json: {} })).status).toBe(200);

    const other = createUser(t.db);
    const logId = latestEmail(t.db)!.id; // the test email just sent
    for (const [method, url] of [
      // The email log holds comedians' sign-in codes and links.
      ['GET', '/api/email-log'],
      ['GET', `/api/email-log/${logId}`],
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['PATCH', `/api/users/${other.id}`],
      ['DELETE', `/api/users/${other.id}`],
      ['POST', `/api/users/${other.id}/resend-invite`],
      ['GET', '/api/backup'],
    ] as const) {
      const res = await t.request(url, { method, headers, json: ['GET', 'DELETE'].includes(method) ? undefined : {} });
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(await readJson(res)).toMatchObject({ code: 'forbidden' });
      expect((await t.request(url, { method })).status, `anonymous ${method} ${url}`).toBe(401);
    }
  });
});

describe('GET/PUT /api/settings', () => {
  it('never returns the SMTP password', async () => {
    configureSmtp();
    const res = await t.request('/api/settings', { headers: admin.headers });
    const raw = await res.text();
    expect(raw).not.toContain('hunter2-secret');
    const body = JSON.parse(raw) as SettingsDto & { smtpPass?: unknown };
    expect(body.smtpPass).toBeUndefined();
    expect(body).toMatchObject({
      clubName: 'Test Comedy Club',
      timezone: 'America/New_York',
      appUrl: TEST_APP_URL,
      effectiveAppUrl: TEST_APP_URL,
      smtpHost: 'smtp.example.test',
      smtpUser: 'mailer@example.test',
      smtpPassSet: true,
      emailConfigured: true,
      emailSource: 'settings',
      emailHost: 'smtp.example.test',
      emailFrom: '"Test Comedy Club" <mailer@example.test>',
    });

    // PUT responses don't leak it either.
    const putRaw = await (await put({ fromName: 'Bookings' })).text();
    expect(putRaw).not.toContain('hunter2-secret');
    expect(JSON.parse(putRaw)).not.toHaveProperty('smtpPass');
  });

  it('reports outbox mode when nothing is configured', async () => {
    expect(await getSettingsDto()).toMatchObject({
      smtpHost: '',
      smtpPassSet: false,
      emailConfigured: false,
      emailSource: null,
      emailHost: null,
      emailFrom: null,
    });
  });

  it('keeps the saved password when smtpPass is blank or omitted, replaces it when given, clears it on request', async () => {
    configureSmtp();
    expect((await put({ smtpPass: '   ', fromName: 'Bookings' })).status).toBe(200);
    expect(getSettings(t.db).smtpPass).toBe('hunter2-secret');

    // Sending the connection fields back unchanged (the Email tab always does) keeps it too.
    expect(
      (await put({ smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecure: true, smtpUser: 'mailer@example.test', smtpPass: '' }))
        .status,
    ).toBe(200);
    expect(getSettings(t.db).smtpPass).toBe('hunter2-secret');

    // A new server/port/security/username without the password again removes the saved one:
    // it is only ever sent to the server it was entered for (security#1).
    for (const change of [
      { smtpHost: 'smtp.other.test' },
      { smtpPort: 587 },
      { smtpSecure: false },
      { smtpUser: 'new@example.test' },
    ]) {
      configureSmtp();
      expect((await put({ ...change, smtpPass: '' })).status).toBe(200);
      expect(getSettings(t.db).smtpPass, JSON.stringify(change)).toBe('');
      expect((await getSettingsDto()).smtpPassSet).toBe(false);
    }
    // …unless it comes with the password.
    configureSmtp();
    expect((await put({ smtpHost: 'smtp.other.test', smtpPass: 'hunter2-secret' })).status).toBe(200);
    expect(getSettings(t.db)).toMatchObject({ smtpHost: 'smtp.other.test', smtpPass: 'hunter2-secret' });

    const replaced = await readJson<SettingsDto>(await put({ smtpPass: 'abcd efgh ijkl mnop' }));
    expect(replaced.smtpPassSet).toBe(true);
    expect(getSettings(t.db).smtpPass).toBe('abcd efgh ijkl mnop');

    const cleared = await readJson<SettingsDto>(await put({ clearSmtpPass: true, smtpPass: 'ignored' }));
    expect(cleared.smtpPassSet).toBe(false);
    expect(getSettings(t.db).smtpPass).toBe('');
  });

  it('saves club fields and they show up in /api/auth/me', async () => {
    const res = await put({
      clubName: '  The Laugh Track ',
      timezone: 'America/Los_Angeles',
      appUrl: 'https://booking.laughtrack.test///',
      allNightStartMin: 1200,
      allNightEndMin: 1440,
      confirmationsEnabled: false,
      confirmationDay: 4,
      confirmationTimeMin: 570,
    });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      clubName: 'The Laugh Track',
      timezone: 'America/Los_Angeles',
      appUrl: 'https://booking.laughtrack.test',
      effectiveAppUrl: 'https://booking.laughtrack.test',
      allNightStartMin: 1200,
      allNightEndMin: 1440,
      confirmationsEnabled: false,
      confirmationDay: 4,
      confirmationTimeMin: 570,
    });

    const me = await readJson<MeResponse>(await t.request('/api/auth/me', { headers: admin.headers }));
    expect(me.club).toEqual({
      name: 'The Laugh Track',
      timezone: 'America/Los_Angeles',
      allNight: { startMin: 1200, endMin: 1440 },
      allowDeclines: false,
    });
  });

  it('lists the weeks (this one on) whose automatic send already ran, for the Confirmations tab', async () => {
    const thisWeek = weekStartOf(clubToday(t.db));
    expect((await getSettingsDto()).confirmationWeeksSent).toEqual([]);
    for (const week of [addDays(thisWeek, -7), thisWeek, addDays(thisWeek, 7)]) {
      t.db.insert(jobRuns).values({ key: confirmationsJobKey(week), ranAt: 1 }).run();
    }
    t.db.insert(jobRuns).values({ key: catchUpJobKey(thisWeek), ranAt: 1 }).run();
    expect((await getSettingsDto()).confirmationWeeksSent).toEqual([thisWeek, addDays(thisWeek, 7)]);
  });

  it('defaults catch-up on and declines off, saves both, and exposes allowDeclines as club info', async () => {
    expect(await getSettingsDto()).toMatchObject({ catchUpEnabled: true, allowDeclines: false });

    const res = await put({ catchUpEnabled: false, allowDeclines: true });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ catchUpEnabled: false, allowDeclines: true });
    expect(getSettings(t.db)).toMatchObject({ catchUpEnabled: false, allowDeclines: true });
    // Other confirmation settings are untouched by a partial save.
    expect(await getSettingsDto()).toMatchObject({ confirmationsEnabled: true, confirmationDay: 1, confirmationTimeMin: 600 });

    // Comedians (portal) and bookers learn about declines from the public club info.
    const comedian = createComedian(t.db);
    const { headers } = await loginAsComedian(t, comedian.id);
    const me = await readJson<MeResponse>(await t.request('/api/auth/me', { headers }));
    expect(me.club.allowDeclines).toBe(true);

    // Any booker can change them; they're booleans only.
    const booker = await loginAsBooker(t, { role: 'booker' });
    expect((await put({ allowDeclines: false }, booker.headers)).status).toBe(200);
    expect(getSettings(t.db).allowDeclines).toBe(false);
    for (const body of [{ catchUpEnabled: 'yes' }, { allowDeclines: 1 }, { allowDeclines: null }]) {
      const bad = await put(body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(await readJson(bad)).toMatchObject({ code: 'validation_error' });
    }
    expect(getSettings(t.db)).toMatchObject({ catchUpEnabled: false, allowDeclines: false });
  });

  it('accepts an empty body and an empty app URL', async () => {
    expect((await put({})).status).toBe(200);
    const res = await put({ appUrl: '' });
    expect(res.status).toBe(200);
    expect((await readJson<SettingsDto>(res)).appUrl).toBe('');
  });

  it('validates fields', async () => {
    const bad: [unknown, string][] = [
      [{ timezone: 'Mars/Olympus_Mons' }, 'timezone'],
      [{ timezone: '' }, 'timezone'],
      [{ clubName: '   ' }, 'clubName'],
      [{ appUrl: 'booking.club.com' }, 'appUrl'],
      [{ appUrl: 'ftp://club.com' }, 'appUrl'],
      [{ allNightStartMin: 1380, allNightEndMin: 1140 }, 'allNightEndMin'],
      [{ allNightStartMin: 1200, allNightEndMin: 1200 }, 'allNightEndMin'],
      [{ allNightStartMin: 900 }, 'allNightStartMin'],
      [{ allNightEndMin: 1590 }, 'allNightEndMin'],
      [{ allNightStartMin: 1140.5 }, 'allNightStartMin'],
      [{ confirmationDay: 7 }, 'confirmationDay'],
      [{ confirmationDay: -1 }, 'confirmationDay'],
      [{ confirmationDay: 1.5 }, 'confirmationDay'],
      [{ confirmationTimeMin: 1440 }, 'confirmationTimeMin'],
      [{ confirmationTimeMin: -30 }, 'confirmationTimeMin'],
      [{ confirmationTimeMin: '10:00' }, 'confirmationTimeMin'],
      [{ confirmationsEnabled: 'yes' }, 'confirmationsEnabled'],
      [{ smtpHost: 'https://smtp.gmail.com' }, 'smtpHost'],
      [{ smtpPort: 0 }, 'smtpPort'],
      [{ smtpPort: 70000 }, 'smtpPort'],
      [{ fromEmail: 'not an email' }, 'fromEmail'],
      [{ replyTo: 'nope@' }, 'replyTo'],
    ];
    for (const [json, field] of bad) {
      const res = await put(json);
      expect(res.status, JSON.stringify(json)).toBe(400);
      const body = await readJson<ApiErrorBody & { issues: { path: string }[] }>(res);
      expect(body.code).toBe('validation_error');
      expect(body.issues[0]?.path, JSON.stringify(json)).toBe(field);
    }
    // Nothing was saved.
    expect(getSettings(t.db)).toMatchObject({ timezone: 'America/New_York', confirmationDay: 1, allNightEndMin: 1380 });
  });

  it('checks a one-sided all-night change against the saved value', async () => {
    // Saved range is 7–11 PM; moving only the start past the end is invalid.
    const res = await put({ allNightStartMin: 1400 });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ code: 'validation_error', issues: [{ path: 'allNightEndMin' }] });
    expect((await put({ allNightEndMin: 1500 })).status).toBe(200);
    expect((await put({ allNightStartMin: 1400 })).status).toBe(200);
    expect(getSettings(t.db)).toMatchObject({ allNightStartMin: 1400, allNightEndMin: 1500 });
  });

  it('requires a From email when the SMTP username is not an email address', async () => {
    const res = await put({ smtpHost: 'smtp.resend.com', smtpPort: 465, smtpSecure: true, smtpUser: 'resend' });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ code: 'from_email_required', issues: [{ path: 'fromEmail' }] });

    const ok = await put({
      smtpHost: 'smtp.resend.com',
      smtpUser: 'resend',
      smtpPass: 're_123',
      fromEmail: 'Booking@LaughTrack.test',
    });
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toMatchObject({
      fromEmail: 'booking@laughtrack.test',
      emailConfigured: true,
      emailFrom: '"Test Comedy Club" <booking@laughtrack.test>',
    });

    // Disconnecting (blank host) needs no From email.
    const off = await put({ smtpHost: '', smtpUser: '', fromEmail: '', clearSmtpPass: true });
    expect(off.status).toBe(200);
    expect(await readJson(off)).toMatchObject({ emailConfigured: false, smtpPassSet: false });
  });
});

describe('email settings and the app URL are admin-only (security#1)', () => {
  it('rejects a booker changing any of them with 403 admin_only, saving nothing', async () => {
    configureSmtp();
    const before = getSettings(t.db);
    const { headers } = await loginAsBooker(t, { role: 'booker' });
    for (const json of [
      { appUrl: 'https://evil.example' },
      { smtpHost: '127.0.0.1' },
      { smtpPort: 2525 },
      { smtpSecure: false },
      { smtpUser: 'attacker@evil.test' },
      { smtpPass: 'mine-now' },
      { clearSmtpPass: true },
      { fromName: 'IT Support' },
      { fromEmail: 'it@evil.test' },
      { replyTo: 'me@evil.test' },
      // Mixed with allowed fields: the whole request is refused.
      { clubName: 'Renamed', appUrl: 'https://evil.example' },
    ]) {
      const res = await put(json, headers);
      expect(res.status, JSON.stringify(json)).toBe(403);
      const body = await readJson<ApiErrorBody & { fields: string[] }>(res);
      expect(body.code).toBe('admin_only');
      expect(body.error).toBe('Only admins can change email settings and the app address');
      expect(body.fields.length).toBe(1);
    }
    expect(getSettings(t.db)).toEqual(before);
  });

  it('lets a booker save other settings, and send email fields back unchanged', async () => {
    configureSmtp();
    const { headers } = await loginAsBooker(t, { role: 'booker' });
    const dto = await getSettingsDto(headers);
    const res = await put(
      {
        clubName: 'Renamed',
        timezone: 'America/Chicago',
        allNightStartMin: 1200,
        appUrl: `${dto.appUrl}/`, // normalised to the saved value
        smtpHost: dto.smtpHost,
        smtpPort: dto.smtpPort,
        smtpSecure: dto.smtpSecure,
        smtpUser: dto.smtpUser,
        smtpPass: '',
        clearSmtpPass: false,
        fromName: dto.fromName,
        fromEmail: dto.fromEmail,
        replyTo: dto.replyTo,
        confirmationDay: 2,
        catchUpEnabled: false,
      },
      headers,
    );
    expect(res.status).toBe(200);
    expect(getSettings(t.db)).toMatchObject({
      clubName: 'Renamed',
      timezone: 'America/Chicago',
      confirmationDay: 2,
      catchUpEnabled: false,
      smtpPass: 'hunter2-secret',
      appUrl: TEST_APP_URL,
    });
  });

  it('the proof of concept: a booker can no longer harvest the SMTP password or relay mail', async () => {
    // A fake SMTP server that advertises AUTH without TLS and records every line.
    const captured: string[] = [];
    const server = net.createServer((sock) => {
      let inData = false;
      let buf = '';
      sock.write('220 evil ESMTP\r\n');
      sock.on('data', (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          captured.push(line);
          if (inData) {
            if (line === '.') {
              inData = false;
              sock.write('250 ok\r\n');
            }
            continue;
          }
          const cmd = line.split(' ')[0]!.toUpperCase();
          if (cmd === 'EHLO') sock.write('250-evil\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (cmd === 'AUTH') sock.write('235 ok\r\n');
          else if (cmd === 'DATA') {
            inData = true;
            sock.write('354 go\r\n');
          } else if (cmd === 'QUIT') {
            sock.write('221 bye\r\n');
            sock.end();
          } else sock.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const SECRET = 'S3cret-App-Pass';
    const leaked = () =>
      captured.some((line) => line.includes(SECRET) || /^AUTH PLAIN /i.test(line) && Buffer.from(line.split(' ')[2] ?? '', 'base64').toString().includes(SECRET));

    try {
      updateSettings(t.db, {
        smtpHost: 'smtp.gmail.com',
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: 'club@gmail.com',
        smtpPass: SECRET,
      });
      const booker = await loginAsBooker(t, { role: 'booker' });
      const attack = await put({ smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false, appUrl: 'https://evil.example' }, booker.headers);
      expect(attack.status).toBe(403);
      expect(getSettings(t.db)).toMatchObject({ smtpHost: 'smtp.gmail.com', smtpPass: SECRET, appUrl: TEST_APP_URL });

      // Even an admin repointing the server (by mistake, or a stolen admin session) doesn't
      // carry the saved password along: it's removed unless typed again.
      const repoint = await put({ smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false });
      expect(repoint.status).toBe(200);
      expect(getSettings(t.db).smtpPass).toBe('');
      const test = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
      // With no password there's nothing to log in with: the send fails before any AUTH.
      expect(test.status).toBe(502);
      expect(await readJson(test)).toMatchObject({ code: 'email_failed', smtpError: expect.stringMatching(/credentials/i) });
      expect(captured.some((line) => line.startsWith('EHLO'))).toBe(true); // it did reach the server…
      expect(captured.some((line) => /^AUTH/i.test(line))).toBe(false); // …but never tried to log in
      expect(leaked()).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('POST /api/settings/test-email', () => {
  it('sends the test email to the signed-in booker', async () => {
    configureSmtp();
    const sent: SendMailOptions[] = [];
    fakeTransport(async (mail) => {
      sent.push(mail);
      return { messageId: 'x' };
    });

    const res = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(res.status).toBe(200);
    const body = await readJson<TestEmailResponse>(res);
    expect(body).toMatchObject({ status: 'sent', to: 'ada@example.test' });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'ada@example.test',
      from: '"Test Comedy Club" <mailer@example.test>',
      subject: 'Test email from Test Comedy Club',
    });
    const row = latestEmail(t.db, 'ada@example.test');
    expect(row).toMatchObject({ id: body.logId, kind: 'test', status: 'sent', error: null });
    expect(row?.bodyText).toContain('Hi Ada,');
  });

  it('can send to another address', async () => {
    configureSmtp();
    const sent: SendMailOptions[] = [];
    fakeTransport(async (mail) => {
      sent.push(mail);
      return {};
    });
    const res = await t.request('/api/settings/test-email', {
      method: 'POST',
      headers: admin.headers,
      json: { to: 'Owner@Club.test' },
    });
    expect(res.status).toBe(200);
    expect(sent[0]?.to).toBe('owner@club.test');

    const bad = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: { to: 'x' } });
    expect(bad.status).toBe(400);
  });

  it('lets bookers send it only to themselves (admins anywhere)', async () => {
    const { headers } = await loginAsBooker(t, { role: 'booker', email: 'bo@example.test' });
    const other = await t.request('/api/settings/test-email', {
      method: 'POST',
      headers,
      json: { to: 'victim@elsewhere.test' },
    });
    expect(other.status).toBe(403);
    expect(await readJson(other)).toMatchObject({ code: 'forbidden' });
    expect(emailsTo(t.db, 'victim@elsewhere.test')).toHaveLength(0);

    const self = await t.request('/api/settings/test-email', { method: 'POST', headers, json: { to: 'BO@example.test' } });
    expect(self.status).toBe(200);
    expect(await readJson(self)).toMatchObject({ to: 'bo@example.test' });

    const byAdmin = await t.request('/api/settings/test-email', {
      method: 'POST',
      headers: admin.headers,
      json: { to: 'owner@elsewhere.test' },
    });
    expect(byAdmin.status).toBe(200);
  });

  it('goes to the outbox when email is not configured', async () => {
    const res = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ status: 'outbox', to: 'ada@example.test' });
    expect(latestEmail(t.db)).toMatchObject({ kind: 'test', status: 'outbox' });
  });

  it('surfaces the SMTP error with a readable hint', async () => {
    configureSmtp('smtp.gmail.com');
    fakeTransport(async () => {
      throw new Error('Invalid login: 535-5.7.8 Username and Password not accepted.');
    });

    const res = await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(res.status).toBe(502);
    const body = await readJson<ApiErrorBody & { smtpError: string; hint: string; logId: number }>(res);
    expect(body.code).toBe('email_failed');
    expect(body.error).toContain('Username and Password not accepted');
    expect(body.smtpError).toBe('Invalid login: 535-5.7.8 Username and Password not accepted.');
    expect(body.hint).toContain('App Password');
    expect(latestEmail(t.db)).toMatchObject({ id: body.logId, kind: 'test', status: 'failed' });
    expect(latestEmail(t.db)?.error).toContain('535');

    // Settings report the failure (outbox emails don't count as attempts).
    await t.request('/api/auth/comedian/request-code', { method: 'POST', json: { email: 'nobody@example.test' } });
    expect((await getSettingsDto()).lastEmail).toMatchObject({ status: 'failed', error: expect.stringContaining('535') });
  });

  it('reports the last real send in settings, ignoring the outbox', async () => {
    expect((await getSettingsDto()).lastEmail).toBeNull();
    await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect(latestEmail(t.db)?.status).toBe('outbox');
    expect((await getSettingsDto()).lastEmail).toBeNull();

    configureSmtp();
    fakeTransport(async () => ({}));
    await t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    expect((await getSettingsDto()).lastEmail).toMatchObject({ status: 'sent', error: null });
  });

  it('gives up with 504 when the server never answers', async () => {
    configureSmtp();
    fakeTransport(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const pending = t.request('/api/settings/test-email', { method: 'POST', headers: admin.headers, json: {} });
    let done = false;
    void pending.finally(() => (done = true));
    for (let i = 0; i < 40 && !done; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(TEST_EMAIL_TIMEOUT_MS / 10);
    }
    const res = await pending;
    expect(res.status).toBe(504);
    const body = await readJson<ApiErrorBody & { hint: string }>(res);
    expect(body.code).toBe('email_timeout');
    expect(body.error).toContain('smtp.example.test:465');
    expect(body.hint).toContain('smtp.example.test:465');
  });
});

describe('smtpErrorHint', () => {
  const server = { host: 'smtp.example.test', port: 587 };
  it.each([
    ['getaddrinfo ENOTFOUND smtp.exampel.test', 'Check the spelling'],
    ['connect ECONNREFUSED 127.0.0.1:2525', 'refused the connection'],
    ['ssl3_get_record:wrong version number', 'secure connection'],
    ['Connection timeout', 'outgoing email'],
    ['Invalid login: 535 Authentication failed', 'username or password'],
    ['self-signed certificate in certificate chain', 'certificate'],
    ['550 5.7.1 Sender address not verified', 'From address'],
    ['Something odd', 'Double-check'],
  ])('%s', (error, expected) => {
    expect(smtpErrorHint(error, server)).toContain(expected);
  });

  it('tailors auth hints to the provider', () => {
    expect(smtpErrorHint('Invalid login: 535', { host: 'smtp.resend.com', port: 465 })).toContain('"resend"');
    expect(smtpErrorHint('Invalid login: 535', { host: 'smtp.postmarkapp.com', port: 587 })).toContain('Server API token');
  });
});

describe('email log', () => {
  function insertEmails(n: number) {
    const sqlite = t.db.$client;
    const stmt = sqlite.prepare(
      `insert into email_log (to_email, subject, kind, status, error, body_html, body_text, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 1; i <= n; i++) {
      stmt.run(
        i % 2 ? `odd${i}@example.test` : `even${i}@example.test`,
        `Subject ${i}`,
        i % 3 === 0 ? 'login_code' : 'confirmation',
        i % 5 === 0 ? 'failed' : 'outbox',
        i % 5 === 0 ? 'boom' : null,
        `<p>Body ${i}</p>`,
        `Body ${i}`,
        1_700_000_000_000 + i,
      );
    }
  }

  it('lists the newest 100 without bodies', async () => {
    insertEmails(105);
    const res = await t.request('/api/email-log', { headers: admin.headers });
    expect(res.status).toBe(200);
    const items = await readJson<(EmailLogItem & { bodyHtml?: string })[]>(res);
    expect(items).toHaveLength(100);
    expect(items[0]).toMatchObject({ subject: 'Subject 105', kind: 'login_code', status: 'failed', error: 'boom' });
    expect(items[99]?.subject).toBe('Subject 6');
    expect(items[0]).not.toHaveProperty('bodyHtml');
    expect(items[0]).not.toHaveProperty('bodyText');
  });

  it('filters by search, kind and status', async () => {
    insertEmails(30);
    const get = async (query: string) =>
      readJson<EmailLogItem[]>(await t.request(`/api/email-log?${query}`, { headers: admin.headers }));

    expect((await get('q=even2')).map((e) => e.toEmail)).toEqual([
      'even28@example.test',
      'even26@example.test',
      'even24@example.test',
      'even22@example.test',
      'even20@example.test',
      'even2@example.test',
    ]);
    expect((await get('q=Subject%2017')).map((e) => e.id)).toHaveLength(1);
    expect((await get('q=%25')).length).toBe(0); // literal %, not a wildcard
    expect((await get('kind=login_code')).every((e) => e.kind === 'login_code')).toBe(true);
    expect((await get('kind=login_code')).length).toBe(10);
    expect((await get('status=failed&limit=2')).map((e) => e.subject)).toEqual(['Subject 30', 'Subject 25']);
    expect((await t.request('/api/email-log?kind=spam', { headers: admin.headers })).status).toBe(400);
  });

  it('shows one email with its rendered body', async () => {
    // A real outbox email: the comedian sign-in code a dev user needs to read.
    const comedian = createComedian(t.db, { email: 'john@example.test', name: 'John' });
    await t.request('/api/auth/comedian/request-code', { method: 'POST', json: { email: comedian.email } });
    const row = latestEmail(t.db, 'john@example.test')!;
    expect(row.status).toBe('outbox');

    const res = await t.request(`/api/email-log/${row.id}`, { headers: admin.headers });
    expect(res.status).toBe(200);
    const detail = await readJson<EmailLogDetail>(res);
    expect(detail).toMatchObject({ id: row.id, toEmail: 'john@example.test', kind: 'login_code', status: 'outbox' });
    expect(detail.comedianId).toBe(comedian.id);
    expect(detail.bodyHtml).toContain('<');
    expect(detail.bodyText).toMatch(/\b\d{6}\b/);

    expect((await t.request('/api/email-log/99999', { headers: admin.headers })).status).toBe(404);
    expect((await t.request('/api/email-log/abc', { headers: admin.headers })).status).toBe(400);
  });
});

describe('bookers (users)', () => {
  async function listUsers(): Promise<BookerUserDto[]> {
    const res = await t.request('/api/users', { headers: admin.headers });
    expect(res.status).toBe(200);
    return readJson<BookerUserDto[]>(res);
  }

  it('lists bookers with their status', async () => {
    createUser(t.db, { name: 'Bea Booker', email: 'bea@example.test' });
    const { user: pending } = createInvite(t.db, { name: 'Pat Pending', email: 'pat@example.test', role: 'booker' });
    const { user: stale } = createInvite(t.db, { name: 'Old Invite', email: 'old@example.test', role: 'admin' });
    t.db.update(users).set({ inviteExpiresAt: Date.now() - 1000 }).where(eq(users.id, stale.id)).run();

    const list = await listUsers();
    expect(list.map((u) => [u.email, u.role, u.status])).toEqual([
      ['ada@example.test', 'admin', 'active'],
      ['bea@example.test', 'booker', 'active'],
      ['pat@example.test', 'booker', 'invited'],
      ['old@example.test', 'admin', 'invite_expired'],
    ]);
    expect(list.find((u) => u.id === pending.id)?.inviteExpiresAt).toBeGreaterThan(Date.now());
    expect(list[0]?.inviteExpiresAt).toBeNull();
    for (const u of list) {
      expect(u).not.toHaveProperty('passwordHash');
      expect(u).not.toHaveProperty('inviteTokenHash');
    }
  });

  it('invites a booker: returns a working invite link and emails it', async () => {
    const res = await t.request('/api/users', {
      method: 'POST',
      headers: admin.headers,
      json: { name: ' Sam Booker ', email: 'Sam@Example.test', role: 'booker' },
    });
    expect(res.status).toBe(201);
    const body = await readJson<InviteResponse>(res);
    expect(body.user).toMatchObject({ name: 'Sam Booker', email: 'sam@example.test', role: 'booker', status: 'invited' });
    expect(body.inviteUrl).toMatch(new RegExp(`^${TEST_APP_URL}/accept-invite/[\\w-]+$`));
    expect(body.email).toEqual({ status: 'outbox' });

    const email = latestEmail(t.db, 'sam@example.test');
    expect(email).toMatchObject({ kind: 'booker_invite', status: 'outbox' });
    expect(email?.bodyText).toContain(body.inviteUrl);
    expect(email?.subject).toContain('Ada Admin');

    // The link works: the invitee sets a password and is signed in.
    const token = body.inviteUrl.split('/').pop()!;
    expect((await t.request(`/api/auth/invite/${token}`)).status).toBe(200);
    const accepted = await t.request('/api/auth/accept-invite', {
      method: 'POST',
      json: { token, password: 'a-good-password' },
    });
    expect(accepted.status).toBe(200);
    expect((await listUsers()).find((u) => u.email === 'sam@example.test')?.status).toBe('active');
  });

  it('can create the invite without emailing it, and rejects duplicates and bad input', async () => {
    const res = await t.request('/api/users', {
      method: 'POST',
      headers: admin.headers,
      json: { name: 'Quiet', email: 'quiet@example.test', role: 'admin', sendEmail: false },
    });
    expect(res.status).toBe(201);
    expect(await readJson(res)).toMatchObject({ user: { role: 'admin' }, email: { status: 'skipped' } });
    expect(emailsTo(t.db, 'quiet@example.test')).toHaveLength(0);

    const dup = await t.request('/api/users', {
      method: 'POST',
      headers: admin.headers,
      json: { name: 'Again', email: 'QUIET@example.test' },
    });
    expect(dup.status).toBe(409);
    expect(await readJson(dup)).toMatchObject({ code: 'email_taken' });

    for (const json of [{ name: '', email: 'x@example.test' }, { name: 'X', email: 'nope' }, { name: 'X', email: 'x@example.test', role: 'owner' }]) {
      expect((await t.request('/api/users', { method: 'POST', headers: admin.headers, json })).status).toBe(400);
    }
  });

  it('reports a failed invite email but still returns the link', async () => {
    configureSmtp();
    fakeTransport(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const res = await t.request('/api/users', {
      method: 'POST',
      headers: admin.headers,
      json: { name: 'Sam', email: 'sam@example.test' },
    });
    expect(res.status).toBe(201);
    const body = await readJson<InviteResponse>(res);
    expect(body.email).toEqual({ status: 'failed', error: 'connect ECONNREFUSED' });
    expect(body.inviteUrl).toContain('/accept-invite/');
  });

  it('resends an invite with a fresh link (the old one stops working)', async () => {
    const created = await readJson<InviteResponse>(
      await t.request('/api/users', {
        method: 'POST',
        headers: admin.headers,
        json: { name: 'Sam', email: 'sam@example.test', sendEmail: false },
      }),
    );
    const oldToken = created.inviteUrl.split('/').pop()!;

    const res = await t.request(`/api/users/${created.user.id}/resend-invite`, { method: 'POST', headers: admin.headers, json: {} });
    expect(res.status).toBe(200);
    const body = await readJson<InviteResponse>(res);
    expect(body.inviteUrl).not.toBe(created.inviteUrl);
    expect(body.email.status).toBe('outbox');
    expect(latestEmail(t.db, 'sam@example.test')?.bodyText).toContain(body.inviteUrl);

    expect((await t.request(`/api/auth/invite/${oldToken}`)).status).toBe(404);
    expect((await t.request(`/api/auth/invite/${body.inviteUrl.split('/').pop()}`)).status).toBe(200);

    // A link only (no email) for copy/paste.
    const linkOnly = await t.request(`/api/users/${created.user.id}/resend-invite`, {
      method: 'POST',
      headers: admin.headers,
      json: { sendEmail: false },
    });
    expect(await readJson(linkOnly)).toMatchObject({ email: { status: 'skipped' } });
    expect(emailsTo(t.db, 'sam@example.test')).toHaveLength(1);

    // Active bookers and unknown ids.
    expect((await t.request(`/api/users/${admin.user.id}/resend-invite`, { method: 'POST', headers: admin.headers, json: {} })).status).toBe(409);
    expect((await t.request('/api/users/9999/resend-invite', { method: 'POST', headers: admin.headers, json: {} })).status).toBe(404);
  });

  it('changes roles but never demotes the last admin', async () => {
    const bea = createUser(t.db, { name: 'Bea', role: 'booker' });

    // Ada is the only admin.
    const demoteSelf = await t.request(`/api/users/${admin.user.id}`, {
      method: 'PATCH',
      headers: admin.headers,
      json: { role: 'booker' },
    });
    expect(demoteSelf.status).toBe(409);
    expect(await readJson(demoteSelf)).toMatchObject({ code: 'last_admin' });

    // A pending (invited) admin doesn't count: they can't sign in yet.
    createInvite(t.db, { name: 'Pending Admin', email: 'pa@example.test', role: 'admin' });
    expect(
      (await t.request(`/api/users/${admin.user.id}`, { method: 'PATCH', headers: admin.headers, json: { role: 'booker' } }))
        .status,
    ).toBe(409);

    const promote = await t.request(`/api/users/${bea.id}`, { method: 'PATCH', headers: admin.headers, json: { role: 'admin' } });
    expect(promote.status).toBe(200);
    expect(await readJson(promote)).toMatchObject({ id: bea.id, role: 'admin', status: 'active' });

    // With Bea as a second admin, Ada can step down.
    const stepDown = await t.request(`/api/users/${admin.user.id}`, {
      method: 'PATCH',
      headers: admin.headers,
      json: { role: 'booker' },
    });
    expect(stepDown.status).toBe(200);
    // …and is no longer allowed in.
    expect((await t.request('/api/users', { headers: admin.headers })).status).toBe(403);

    const rename = await t.request(`/api/users/${bea.id}`, {
      method: 'PATCH',
      headers: (await loginAsBooker(t, { role: 'admin' })).headers,
      json: { name: '  Bea Arthur ' },
    });
    expect(await readJson(rename)).toMatchObject({ name: 'Bea Arthur', role: 'admin' });
  });

  it('validates role changes', async () => {
    const bea = createUser(t.db);
    const patch = (id: number | string, json: unknown) =>
      t.request(`/api/users/${id}`, { method: 'PATCH', headers: admin.headers, json });
    expect((await patch(bea.id, { role: 'owner' })).status).toBe(400);
    expect((await patch(bea.id, {})).status).toBe(400);
    expect((await patch(9999, { role: 'admin' })).status).toBe(404);
    expect((await patch('abc', { role: 'admin' })).status).toBe(400);
  });

  it('removes a booker, signs them out, and keeps their notes', async () => {
    const { user: bea, headers: beaHeaders } = await loginAsBooker(t, { role: 'booker', name: 'Bea' });
    const comedian = createComedian(t.db);
    const note = createNote(t.db, { comedianId: comedian.id, authorId: bea.id, body: 'Great closer' });
    expect((await t.request('/api/settings', { headers: beaHeaders })).status).toBe(200);

    const res = await t.request(`/api/users/${bea.id}`, { method: 'DELETE', headers: admin.headers });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });

    expect(t.db.select().from(users).where(eq(users.id, bea.id)).get()).toBeUndefined();
    expect(t.db.select().from(sessions).where(eq(sessions.subjectId, bea.id)).all()).toEqual([]);
    expect((await t.request('/api/settings', { headers: beaHeaders })).status).toBe(401);
    expect(t.db.select().from(notes).where(eq(notes.id, note.id)).get()).toMatchObject({ authorId: null });

    expect((await t.request(`/api/users/${bea.id}`, { method: 'DELETE', headers: admin.headers })).status).toBe(404);
  });

  it("can't remove yourself; can remove another admin while you remain", async () => {
    const self = await t.request(`/api/users/${admin.user.id}`, { method: 'DELETE', headers: admin.headers });
    expect(self.status).toBe(409);
    expect(await readJson(self)).toMatchObject({ code: 'cannot_remove_self' });

    const other = createUser(t.db, { role: 'admin' });
    expect((await t.request(`/api/users/${other.id}`, { method: 'DELETE', headers: admin.headers })).status).toBe(200);

    const pending = createInvite(t.db, { name: 'P', email: 'p@example.test', role: 'admin' }).user;
    expect((await t.request(`/api/users/${pending.id}`, { method: 'DELETE', headers: admin.headers })).status).toBe(200);
    expect((await listUsers()).map((u) => u.id)).toEqual([admin.user.id]);
  });
});

describe('GET /api/backup', () => {
  function backupDirs(): Set<string> {
    return new Set(readdirSync(os.tmpdir()).filter((name) => name.startsWith('cbp-backup-')));
  }

  it('downloads a valid SQLite copy of the database and cleans up the temp file', async () => {
    createComedian(t.db, { name: 'Backup Betty', email: 'betty@example.test' });
    configureSmtp();
    const before = backupDirs();

    const res = await t.request('/api/backup', { headers: admin.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="club-backup-${today}.db"`);

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');

    const dir = mkdtempSync(path.join(os.tmpdir(), 'cbp-test-restore-'));
    const file = path.join(dir, 'restored.db');
    writeFileSync(file, bytes);
    const restored = new Database(file, { readonly: true });
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(restored.prepare('select club_name from settings').pluck().get()).toBe('Test Comedy Club');
      expect(restored.prepare('select name from comedians').pluck().all()).toContain('Backup Betty');
      expect(restored.prepare('select email from users').pluck().all()).toContain('ada@example.test');
    } finally {
      restored.close();
    }

    // The temp copy is removed once the download stream closes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const leftovers = [...backupDirs()].filter((name) => !before.has(name));
    expect(leftovers).toEqual([]);
  });
});
