import net from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateSettings } from '../lib/settings';
import { smtpErrorHint } from '../routes/settings';
import { latestEmail, makeTestApp, type TestApp } from '../test/helpers';
import { SMTP_TIMEOUTS, getMailConfig, sendEmail, setTransportFactory, smtpTransportOptions } from './mailer';

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
