import { afterEach, describe, expect, it, vi } from 'vitest';
import { SMTP_TIMEOUTS } from '../email/mailer';
import type { SmtpEnv } from '../env';
import { closePlatformDb, createPlatformDb, type PlatformDb } from './db';
import { createPlatformMailer, formatFrom } from './mailer';
import { platformEmailLog } from './schema';

const SMTP: SmtpEnv = {
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  user: 'resend',
  pass: 're_secret',
  fromEmail: 'hello@mail.comedybook.app',
  fromName: 'Ignored For Platform Mail',
  replyTo: '',
};

const hosted = { platformName: 'Comedy Booking' };
const email = { to: 'owner@example.test', subject: 'Hi', text: 'Body with a link', html: '<p>Body</p>', kind: 'signup_notice' as const };

let db: PlatformDb;

afterEach(() => {
  closePlatformDb(db);
  vi.restoreAllMocks();
});

const rows = () => db.select().from(platformEmailLog).all();

describe('platform mailer', () => {
  it('without SMTP: the outbox, logged with its body before send() resolves, printed unless quiet', async () => {
    db = createPlatformDb(':memory:');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mailer = createPlatformMailer({ db, hosted, smtp: null, quiet: false });
    expect(mailer.from).toBeNull();
    const pending = mailer.send(email);
    expect(rows()).toMatchObject([{ toEmail: 'owner@example.test', status: 'outbox', bodyText: 'Body with a link', kind: 'signup_notice' }]);
    expect(await pending).toMatchObject({ status: 'outbox' });
    expect(log.mock.calls.flat().join('\n')).toContain('PLATFORM OUTBOX');

    log.mockClear();
    createPlatformMailer({ db, hosted, smtp: null, quiet: true }).send(email);
    expect(log).not.toHaveBeenCalled();
  });

  it('with SMTP: sends as "<platformName>" <SMTP_FROM_EMAIL> with the club mailer timeouts, logging no body', async () => {
    db = createPlatformDb(':memory:');
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
    const factory = vi.fn((_smtp: SmtpEnv) => ({ sendMail }));
    const mailer = createPlatformMailer({ db, hosted, smtp: SMTP, transportFactory: factory as never });
    expect(mailer.from).toBe('"Comedy Booking" <hello@mail.comedybook.app>');
    const result = await mailer.send(email);
    expect(result.status).toBe('sent');
    expect(sendMail).toHaveBeenCalledWith({
      from: '"Comedy Booking" <hello@mail.comedybook.app>',
      to: 'owner@example.test',
      subject: 'Hi',
      text: 'Body with a link',
      html: '<p>Body</p>',
    });
    expect(rows()).toMatchObject([{ status: 'sent', bodyText: '', error: null }]);
    // One transport, reused.
    await mailer.send(email);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(SMTP_TIMEOUTS.connectionTimeout).toBeGreaterThan(0);
  });

  it('logs a failure and never throws', async () => {
    db = createPlatformDb(':memory:');
    const sendMail = vi.fn().mockRejectedValue(new Error('535 Authentication failed'));
    const mailer = createPlatformMailer({ db, hosted, smtp: SMTP, transportFactory: () => ({ sendMail }) as never });
    const result = await mailer.send(email);
    expect(result).toMatchObject({ status: 'failed', error: '535 Authentication failed' });
    expect(rows()).toMatchObject([{ status: 'failed', error: '535 Authentication failed', bodyText: '' }]);
  });

  it('flush() waits for sends in flight', async () => {
    db = createPlatformDb(':memory:');
    let release!: () => void;
    const sendMail = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const mailer = createPlatformMailer({ db, hosted, smtp: SMTP, transportFactory: () => ({ sendMail }) as never });
    void mailer.send(email);
    expect(rows()).toEqual([]);
    const flushed = mailer.flush();
    await Promise.resolve();
    release();
    await flushed;
    expect(rows()).toMatchObject([{ status: 'sent' }]);
  });

  it('quotes the display name safely', () => {
    expect(formatFrom('Laughs "R" Us', 'a@b.test')).toBe(`"Laughs 'R' Us" <a@b.test>`);
    expect(formatFrom('', 'a@b.test')).toBe('a@b.test');
  });
});
