/**
 * Who emails come from (hosted MVP spec §5): every row of the sender table, the daily cap
 * on the platform sender, and mailbox passwords encrypted at rest.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailLog, users, type User } from '../db/schema';
import { encryptSecret } from '../lib/secrets';
import { updateSettings, type SettingsUpdate } from '../lib/settings';
import { sendAvailabilityRequest } from '../services/availabilityRequests';
import {
  PLATFORM_SMTP,
  TEST_APP_SECRET,
  captureMail,
  hostedMode,
  restoreEnv,
  setEnv,
  singleClubMode,
} from '../test/emailEnv';
import { createComedian, createUser, emailsTo, latestEmail, makeTestApp, type TestApp } from '../test/helpers';
import {
  dailyCapError,
  getMailConfig,
  isEmailConfigured,
  platformEmailsSentToday,
  previewSender,
  replyToWithAdminFallback,
  sendEmail,
} from './mailer';

let t: TestApp;
let rich: User;

beforeEach(() => {
  singleClubMode();
  t = makeTestApp();
  rich = createUser(t.db, { name: 'Rich Brooks', email: 'rich@bwaygroup.test', role: 'booker' });
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv();
  t.close();
});

const message = {
  to: 'comic@example.test',
  subject: 'When are you free?',
  html: '<p>Hi</p>',
  text: 'Hi',
  kind: 'availability_request' as const,
};

/** The company's own mailbox (Settings → Email). */
function connectCompanyMailbox(extra: SettingsUpdate = {}) {
  updateSettings(t.db, {
    smtpHost: 'smtp.club.test',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'club@club.test',
    smtpPass: 'club-pass',
    ...extra,
  });
}

/** A booker's own mailbox (Settings → Account). */
function connectBookerMailbox(user: User, extra: Partial<User> = {}) {
  t.db
    .update(users)
    .set({
      smtpHost: 'smtp.rich.test',
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: 'rich@richmail.test',
      smtpPass: 'rich-pass',
      ...extra,
    })
    .where(eq(users.id, user.id))
    .run();
}

function bookerMode() {
  updateSettings(t.db, { senderMode: 'booker' });
}

function addAdmin(email = 'ada@bwaygroup.test') {
  return createUser(t.db, { name: 'Ada Admin', email, role: 'admin', createdAt: 1 });
}

// ---------------------------------------------------------------------------
// The sender table
// ---------------------------------------------------------------------------

describe('company sends', () => {
  it('row 1 — company mailbox: "<fromName‖club>" <mailbox address>, replies to the company email', async () => {
    const sent = captureMail();
    connectCompanyMailbox();
    await sendEmail(t.db, message);
    updateSettings(t.db, { fromName: 'Bookings Desk', fromEmail: 'bookings@club.test', replyTo: 'booking@bwaygroup.test' });
    await sendEmail(t.db, message);

    // No company email: no Reply-To, so replies go to the mailbox address itself.
    expect(sent[0]).toMatchObject({
      from: '"Test Comedy Club" <club@club.test>',
      replyTo: undefined,
      server: { host: 'smtp.club.test', port: 587, secure: false, user: 'club@club.test', pass: 'club-pass' },
    });
    expect(sent[1]).toMatchObject({ from: '"Bookings Desk" <bookings@club.test>', replyTo: 'booking@bwaygroup.test' });
    expect(emailsTo(t.db).map((r) => [r.via, r.senderUserId, r.status])).toEqual([
      ['company-mailbox', null, 'sent'],
      ['company-mailbox', null, 'sent'],
    ]);
  });

  it('row 1 in hosted mode: a connected company mailbox wins over the platform sender', async () => {
    hostedMode(t.db);
    const sent = captureMail();
    addAdmin();
    connectCompanyMailbox({ fromName: 'Bookings Desk', fromEmail: 'bookings@club.test' });
    await sendEmail(t.db, message);
    expect(sent[0]).toMatchObject({
      from: '"Bookings Desk" <bookings@club.test>',
      replyTo: undefined,
      server: { host: 'smtp.club.test' },
    });
    expect(latestEmail(t.db)).toMatchObject({ via: 'company-mailbox', status: 'sent' });
    expect(getMailConfig(t.db)).toMatchObject({ source: 'settings', via: 'company-mailbox' });
  });

  it('row 2 — hosted platform sender: "<club>" <SMTP_FROM_EMAIL>, Reply-To the company email else the first admin', async () => {
    hostedMode(t.db);
    const sent = captureMail();
    addAdmin();
    createUser(t.db, { role: 'admin', email: 'later@bwaygroup.test', createdAt: 5 });
    await sendEmail(t.db, message);
    // The club's From name belongs to its own mailbox; the platform sender uses the club's name.
    updateSettings(t.db, { replyTo: 'booking@bwaygroup.test', fromName: 'Bookings Desk' });
    await sendEmail(t.db, message);

    expect(sent[0]).toMatchObject({
      from: '"Test Comedy Club" <bookings@mail.platform.test>',
      replyTo: 'ada@bwaygroup.test',
      server: { host: 'smtp.platform.test', user: 'resend', pass: 're_platform_key' },
    });
    expect(sent[1]).toMatchObject({
      from: '"Test Comedy Club" <bookings@mail.platform.test>',
      replyTo: 'booking@bwaygroup.test',
    });
    // The platform's own From name and Reply-To never reach a club's email.
    for (const mail of sent) {
      expect(String(mail.from)).not.toContain(PLATFORM_SMTP.fromName);
      expect(mail.replyTo).not.toBe(PLATFORM_SMTP.replyTo);
    }
    expect(latestEmail(t.db)).toMatchObject({ via: 'platform', senderUserId: null, status: 'sent' });
    expect(getMailConfig(t.db)).toMatchObject({ source: 'platform', via: 'platform' });
  });

  it('single-club mode keeps the SMTP_* fallback as it was: its From name and Reply-To win', async () => {
    singleClubMode({ smtp: PLATFORM_SMTP });
    const sent = captureMail();
    addAdmin();
    await sendEmail(t.db, message);
    expect(sent[0]).toMatchObject({
      from: '"Comedy Booking Platform" <bookings@mail.platform.test>',
      replyTo: 'noreply@platform.test',
      server: { host: 'smtp.platform.test' },
    });

    // Without them, the club's From name/email; no Reply-To unless replies must reach a person.
    setEnv({ smtp: { ...PLATFORM_SMTP, fromName: '', fromEmail: '', replyTo: '' } });
    updateSettings(t.db, { fromName: 'Desk', fromEmail: 'desk@club.test' });
    await sendEmail(t.db, message);
    await sendEmail(t.db, { ...message, replyToPerson: true });
    expect(sent[1]).toMatchObject({ from: '"Desk" <desk@club.test>', replyTo: undefined });
    expect(sent[2]).toMatchObject({ from: '"Desk" <desk@club.test>', replyTo: 'ada@bwaygroup.test' });
    expect(getMailConfig(t.db)).toMatchObject({ source: 'env' });
    expect(latestEmail(t.db)?.via).toBe('platform');
  });

  it('a message-level Reply-To still overrides the resolved one', async () => {
    const sent = captureMail();
    connectCompanyMailbox({ replyTo: 'desk@club.test' });
    await sendEmail(t.db, { ...message, replyTo: 'other@club.test' });
    expect(sent[0]?.replyTo).toBe('other@club.test');
  });
});

describe('booker sends (senderMode booker)', () => {
  beforeEach(() => bookerMode());

  it('row 3 — their own mailbox: "<U.name> · <club>" <their address>, replies to them', async () => {
    const sent = captureMail();
    connectCompanyMailbox();
    connectBookerMailbox(rich);
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    connectBookerMailbox(rich, { smtpFromEmail: 'rich.brooks@bwaygroup.test' });
    await sendEmail(t.db, { ...message, senderUserId: rich.id });

    expect(sent[0]).toMatchObject({
      from: '"Rich Brooks · Test Comedy Club" <rich@richmail.test>',
      replyTo: 'rich@bwaygroup.test',
      server: { host: 'smtp.rich.test', port: 465, secure: true, user: 'rich@richmail.test', pass: 'rich-pass' },
    });
    expect(sent[1]?.from).toBe('"Rich Brooks · Test Comedy Club" <rich.brooks@bwaygroup.test>');
    expect(latestEmail(t.db)).toMatchObject({ via: 'booker-mailbox', senderUserId: rich.id, status: 'sent' });
  });

  it('row 4 — no own mailbox, the company mailbox: their name at the company address', async () => {
    const sent = captureMail();
    connectCompanyMailbox({ fromName: 'Desk', fromEmail: 'bookings@club.test', replyTo: 'booking@bwaygroup.test' });
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    expect(sent[0]).toMatchObject({
      from: '"Rich Brooks · Test Comedy Club" <bookings@club.test>',
      replyTo: 'rich@bwaygroup.test',
      server: { host: 'smtp.club.test' },
    });
    expect(latestEmail(t.db)).toMatchObject({ via: 'company-mailbox', senderUserId: rich.id });
  });

  it('row 5 — neither, the platform sender: their name at SMTP_FROM_EMAIL', async () => {
    hostedMode(t.db);
    const sent = captureMail();
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    expect(sent[0]).toMatchObject({
      from: '"Rich Brooks · Test Comedy Club" <bookings@mail.platform.test>',
      replyTo: 'rich@bwaygroup.test',
      server: { host: 'smtp.platform.test' },
    });
    expect(latestEmail(t.db)).toMatchObject({ via: 'platform', senderUserId: rich.id });

    // Single-club mode's SMTP_* fallback doesn't override a booker's name either.
    singleClubMode({ smtp: PLATFORM_SMTP }, t.db);
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    expect(sent[1]).toMatchObject({
      from: '"Rich Brooks · Test Comedy Club" <bookings@mail.platform.test>',
      replyTo: 'rich@bwaygroup.test',
    });
  });

  it('row 6 — nothing configured: the outbox, for the company and for a booker', async () => {
    const sent = captureMail();
    await sendEmail(t.db, message);
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    expect(sent).toHaveLength(0);
    expect(emailsTo(t.db).map((r) => [r.status, r.via, r.senderUserId])).toEqual([
      ['outbox', 'outbox', rich.id],
      ['outbox', 'outbox', null],
    ]);

    // A booker's own mailbox still sends their emails when the company has none.
    connectBookerMailbox(rich);
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    expect(sent).toHaveLength(1);
    expect(latestEmail(t.db)).toMatchObject({ status: 'sent', via: 'booker-mailbox' });
  });

  it('a booker who no longer exists is the company, recorded as no one', async () => {
    const sent = captureMail();
    connectCompanyMailbox();
    await sendEmail(t.db, { ...message, senderUserId: 999_999 });
    expect(sent[0]?.from).toBe('"Test Comedy Club" <club@club.test>');
    expect(latestEmail(t.db)).toMatchObject({ senderUserId: null, via: 'company-mailbox' });
  });
});

describe('company mode', () => {
  it('ignores the booker for From and Reply-To (even with their own mailbox), but records them', async () => {
    const sent = captureMail();
    connectCompanyMailbox({ replyTo: 'booking@bwaygroup.test' });
    connectBookerMailbox(rich);
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    expect(sent[0]).toMatchObject({
      from: '"Test Comedy Club" <club@club.test>',
      replyTo: 'booking@bwaygroup.test',
      server: { host: 'smtp.club.test' },
    });
    expect(latestEmail(t.db)).toMatchObject({ via: 'company-mailbox', senderUserId: rich.id });
  });

  it('senderMode overrides resolve as the other mode (the mailbox test)', async () => {
    const sent = captureMail();
    connectCompanyMailbox();
    connectBookerMailbox(rich);
    await sendEmail(t.db, { ...message, senderUserId: rich.id, senderMode: 'booker' });
    expect(sent[0]?.server.host).toBe('smtp.rich.test');
  });
});

describe('previews and "email configured"', () => {
  it('describes what comedians see', () => {
    expect(previewSender(t.db)).toBeNull();
    expect(previewSender(t.db, { senderUserId: rich.id, senderMode: 'booker' })).toBeNull();

    connectCompanyMailbox();
    expect(previewSender(t.db)).toEqual({
      via: 'company-mailbox',
      fromName: 'Test Comedy Club',
      fromEmail: 'club@club.test',
      replyTo: 'club@club.test', // no company email: replies reach the mailbox
    });
    expect(previewSender(t.db, { senderUserId: rich.id, senderMode: 'booker' })).toEqual({
      via: 'company-mailbox',
      fromName: 'Rich Brooks · Test Comedy Club',
      fromEmail: 'club@club.test',
      replyTo: 'rich@bwaygroup.test',
    });

    updateSettings(t.db, { smtpHost: '', smtpUser: '', smtpPass: '' });
    hostedMode(t.db);
    addAdmin();
    expect(previewSender(t.db)).toEqual({
      via: 'platform',
      fromName: 'Test Comedy Club',
      fromEmail: 'bookings@mail.platform.test',
      replyTo: 'ada@bwaygroup.test',
    });
  });

  it('counts the platform sender as configured in hosted mode', () => {
    expect(isEmailConfigured(t.db)).toBe(false);
    hostedMode(t.db);
    expect(isEmailConfigured(t.db)).toBe(true);
    // Hosted, but the server has no platform sender (e.g. local dev): the outbox.
    setEnv({ smtp: null });
    expect(isEmailConfigured(t.db)).toBe(false);
    // A booker's own mailbox doesn't make the company's email work.
    connectBookerMailbox(rich);
    expect(isEmailConfigured(t.db)).toBe(false);
  });

  it('replyToWithAdminFallback: the company email, else the first admin (hosted too)', () => {
    hostedMode(t.db);
    expect(replyToWithAdminFallback(t.db)).toBe('');
    addAdmin();
    expect(replyToWithAdminFallback(t.db)).toBe('ada@bwaygroup.test');
    updateSettings(t.db, { replyTo: 'booking@bwaygroup.test' });
    expect(replyToWithAdminFallback(t.db)).toBe('booking@bwaygroup.test');
  });
});

// ---------------------------------------------------------------------------
// Passwords at rest
// ---------------------------------------------------------------------------

describe('mailbox passwords encrypted at rest', () => {
  it('decrypts the company and booker mailbox passwords for SMTP', async () => {
    setEnv({ appSecret: TEST_APP_SECRET });
    const sent = captureMail();
    connectCompanyMailbox({ smtpPass: encryptSecret('club-pass') });
    connectBookerMailbox(rich, { smtpPass: encryptSecret('rich-pass') });
    await sendEmail(t.db, message);
    bookerMode();
    await sendEmail(t.db, { ...message, senderUserId: rich.id });
    expect(sent.map((m) => m.server.pass)).toEqual(['club-pass', 'rich-pass']);
  });

  it('still reads legacy plaintext passwords once APP_SECRET is set', async () => {
    setEnv({ appSecret: TEST_APP_SECRET });
    const sent = captureMail();
    connectCompanyMailbox({ smtpPass: 'legacy-plain' });
    await sendEmail(t.db, message);
    expect(sent[0]?.server.pass).toBe('legacy-plain');
  });

  it('fails the send, without contacting SMTP, when the password was encrypted with another key', async () => {
    setEnv({ appSecret: 'the-old-secret' });
    connectCompanyMailbox({ smtpPass: encryptSecret('club-pass') });
    setEnv({ appSecret: TEST_APP_SECRET });
    const sent = captureMail();
    const result = await sendEmail(t.db, message);
    expect(sent).toHaveLength(0);
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/APP_SECRET/) });
    expect(latestEmail(t.db)).toMatchObject({ status: 'failed', via: 'company-mailbox' });
    // Reading the config for the settings screen never throws.
    expect(getMailConfig(t.db)).toMatchObject({ pass: '', passError: expect.stringMatching(/APP_SECRET/) });
  });
});

// ---------------------------------------------------------------------------
// Daily cap (hosted mode, platform sender only)
// ---------------------------------------------------------------------------

describe('daily cap on the platform sender', () => {
  /** email_log rows as if sent earlier, at `createdAt`. */
  function logged(n: number, values: Partial<typeof emailLog.$inferInsert> = {}) {
    for (let i = 0; i < n; i++) {
      t.db
        .insert(emailLog)
        .values({ toEmail: `old${i}@example.test`, subject: 'Old', kind: 'confirmation', status: 'sent', via: 'platform', ...values })
        .run();
    }
  }

  it('stops at PLATFORM_DAILY_EMAIL_CAP and logs the rest as failed', async () => {
    hostedMode(t.db, { dailyEmailCap: 2 });
    const sent = captureMail();
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await sendEmail(t.db, { ...message, to: `c${i}@example.test` }));
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent', 'failed']);
    expect(results[2]?.error).toBe('Daily email limit reached (2 per day) — contact support');
    expect(dailyCapError(2000)).toBe('Daily email limit reached (2000 per day) — contact support');
    expect(sent).toHaveLength(2);
    expect(latestEmail(t.db)).toMatchObject({
      toEmail: 'c2@example.test',
      status: 'failed',
      via: 'platform',
      error: 'Daily email limit reached (2 per day) — contact support',
    });
    expect(platformEmailsSentToday(t.db)).toBe(2);
  });

  it('counts emails still in flight, so a blast stops exactly at the cap', async () => {
    hostedMode(t.db, { dailyEmailCap: 3 });
    const sent = captureMail(() => new Promise((resolve) => setTimeout(() => resolve({}), 5)));
    for (let i = 0; i < 5; i++) createComedian(t.db, { email: `blast${i}@example.test` });
    const result = await sendAvailabilityRequest(t.db, {
      month: '2026-12',
      audience: 'all',
      message: '',
      kind: 'request',
      sentById: null,
    });
    expect(result).toMatchObject({ recipientCount: 5, sent: 3, failed: 2 });
    expect(sent).toHaveLength(3);
  });

  it('applies only in hosted mode', async () => {
    singleClubMode({ smtp: PLATFORM_SMTP });
    captureMail();
    logged(5);
    expect((await sendEmail(t.db, message)).status).toBe('sent');
    hostedMode(t.db, { dailyEmailCap: 6 });
    expect((await sendEmail(t.db, message)).status).toBe('failed');
  });

  it('applies only to the platform sender: mailboxes the club connects are exempt', async () => {
    hostedMode(t.db, { dailyEmailCap: 1 });
    const sent = captureMail();
    logged(1);
    bookerMode();
    const maria = createUser(t.db, { name: 'Maria', email: 'maria@bwaygroup.test' });
    connectBookerMailbox(rich);

    // Through the platform: over the cap.
    expect((await sendEmail(t.db, message)).status).toBe('failed');
    expect((await sendEmail(t.db, { ...message, senderUserId: maria.id })).status).toBe('failed');
    // A booker's own mailbox: exempt.
    expect((await sendEmail(t.db, { ...message, senderUserId: rich.id })).status).toBe('sent');
    // The company's own mailbox: exempt, for company and booker emails alike.
    connectCompanyMailbox();
    expect((await sendEmail(t.db, message)).status).toBe('sent');
    expect((await sendEmail(t.db, { ...message, senderUserId: maria.id })).status).toBe('sent');
    expect(sent.map((m) => m.server.host)).toEqual(['smtp.rich.test', 'smtp.club.test', 'smtp.club.test']);
    expect(platformEmailsSentToday(t.db)).toBe(1);
  });

  it('counts only sent platform emails (not failed, outbox or mailbox ones)', async () => {
    hostedMode(t.db, { dailyEmailCap: 1 });
    captureMail();
    logged(3, { status: 'failed' });
    logged(3, { status: 'outbox', via: 'outbox' });
    logged(3, { via: 'company-mailbox' });
    logged(3, { via: 'booker-mailbox' });
    logged(3, { via: '' });
    expect(platformEmailsSentToday(t.db)).toBe(0);
    expect((await sendEmail(t.db, message)).status).toBe('sent');
    expect((await sendEmail(t.db, message)).status).toBe('failed');
  });

  it("resets at midnight in the club's timezone, not UTC", async () => {
    hostedMode(t.db, { dailyEmailCap: 1 });
    captureMail();
    updateSettings(t.db, { timezone: 'America/Los_Angeles' }); // UTC-8 in November
    logged(1, { createdAt: Date.parse('2026-11-03T07:59:00Z') }); // Mon Nov 2, 11:59 PM in LA
    logged(1, { createdAt: Date.parse('2026-11-04T06:00:00Z') }); // Tue Nov 3, 10 PM in LA

    const lateTuesday = new Date('2026-11-04T07:30:00Z'); // Tue Nov 3, 11:30 PM in LA (Wed in UTC)
    const earlyWednesday = new Date('2026-11-04T08:30:00Z'); // Wed Nov 4, 12:30 AM in LA
    expect(platformEmailsSentToday(t.db, lateTuesday)).toBe(1);
    expect(platformEmailsSentToday(t.db, earlyWednesday)).toBe(0);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(lateTuesday);
    expect((await sendEmail(t.db, message)).status).toBe('failed');
    vi.setSystemTime(earlyWednesday);
    expect((await sendEmail(t.db, message)).status).toBe('sent');
  });
});
