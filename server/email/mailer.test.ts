import net from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateSettings } from '../lib/settings';
import { smtpErrorHint } from '../routes/settings';
import { createUser, latestEmail, makeTestApp, type TestApp } from '../test/helpers';
import {
  SMTP_TIMEOUTS,
  getMailConfig,
  replyToWithAdminFallback,
  sendEmail,
  setTransportFactory,
  smtpTransportOptions,
} from './mailer';

let t: TestApp;
beforeEach(() => {
  t = makeTestApp();
});
afterEach(() => {
  setTransportFactory(null);
  t.close();
});

const message = { to: 'someone@example.test', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', kind: 'test' as const };

describe('SMTP timeouts', () => {
  it('every transport gets connect, greeting and socket timeouts (not nodemailer’s 2 minutes)', () => {
    updateSettings(t.db, { smtpHost: 'smtp.example.test', smtpPort: 587, smtpUser: 'u@example.test', smtpPass: 'p' });
    const options = smtpTransportOptions(getMailConfig(t.db)!);
    expect(options).toMatchObject({ host: 'smtp.example.test', port: 587, ...SMTP_TIMEOUTS });
    expect(SMTP_TIMEOUTS.connectionTimeout).toBeLessThanOrEqual(10_000);
    expect(SMTP_TIMEOUTS.greetingTimeout).toBeLessThanOrEqual(10_000);
    expect(SMTP_TIMEOUTS.socketTimeout).toBeLessThanOrEqual(20_000);
  });

  it('a server that accepts but never greets fails the send (logged) instead of hanging', async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => sockets.push(socket)); // never says hello
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      updateSettings(t.db, { smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false, smtpUser: '', fromEmail: 'club@example.test' });
      // The real options, with the greeting wait shortened so the test is quick.
      setTransportFactory((config) => nodemailer.createTransport({ ...smtpTransportOptions(config), greetingTimeout: 200 }));

      const result = await sendEmail(t.db, message);
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/greeting/i);
      expect(latestEmail(t.db)).toMatchObject({ status: 'failed' });
      expect(smtpErrorHint(result.error!, { host: '127.0.0.1', port })).toContain(`Couldn't talk to 127.0.0.1:${port}`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Reply-To', () => {
  function captureSends() {
    const sent: { replyTo?: unknown }[] = [];
    setTransportFactory(() => ({
      sendMail: (async (mail: { replyTo?: unknown }) => {
        sent.push(mail);
        return {};
      }) as never,
    }));
    updateSettings(t.db, { smtpHost: 'smtp.example.test', fromEmail: 'club@example.test' });
    return sent;
  }

  it('uses the configured Reply-To unless the message overrides it', async () => {
    const sent = captureSends();
    await sendEmail(t.db, message);
    updateSettings(t.db, { replyTo: 'desk@example.test' });
    await sendEmail(t.db, message);
    await sendEmail(t.db, { ...message, replyTo: 'booker@example.test' });
    expect(sent.map((m) => m.replyTo)).toEqual([undefined, 'desk@example.test', 'booker@example.test']);
  });

  it('falls back to the first active admin when no Reply-To is configured', () => {
    expect(replyToWithAdminFallback(t.db)).toBe('');
    createUser(t.db, { role: 'booker', email: 'booker@example.test', createdAt: 1 });
    createUser(t.db, { role: 'admin', email: 'invited@example.test', passwordHash: null, createdAt: 2 });
    createUser(t.db, { role: 'admin', email: 'second@example.test', createdAt: 4 });
    createUser(t.db, { role: 'admin', email: 'first@example.test', createdAt: 3 });
    expect(replyToWithAdminFallback(t.db)).toBe('first@example.test');
    updateSettings(t.db, { replyTo: 'desk@example.test' });
    expect(replyToWithAdminFallback(t.db)).toBe('desk@example.test');
  });
});
