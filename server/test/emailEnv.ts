/**
 * Test toolkit for email senders: switch the process env between single-club and hosted
 * mode, and capture what the mailer hands to SMTP.
 *
 * `env` (server/env.ts) is read once at startup, but it's a plain object that the mailer
 * and routes read on every call, so tests set its fields directly. Each vitest file runs
 * in its own worker; restore in `afterEach` anyway so tests stay independent:
 *
 *   beforeEach(() => singleClubMode());           // no SMTP_* env, no APP_SECRET
 *   afterEach(() => restoreEnv());
 *
 *   hostedMode({ dailyEmailCap: 3 });             // PLATFORM_URL set, platform sender, APP_SECRET
 *   const sent = captureMail();                   // every sendMail call, with the server it used
 */
import type { SendMailOptions } from 'nodemailer';
import { env, type Env, type HostedEnv, type SmtpEnv } from '../env';
import { setTransportFactory, type SmtpServer } from '../email/mailer';

type EmailEnv = Pick<Env, 'hosted' | 'smtp' | 'appSecret'>;

const original: EmailEnv = { hosted: env.hosted, smtp: env.smtp, appSecret: env.appSecret };

/** Override the email-related env fields (until `restoreEnv`). */
export function setEnv(patch: Partial<EmailEnv>): void {
  Object.assign(env, patch);
}

/** Put the env back as the process started, and the real SMTP transport. */
export function restoreEnv(): void {
  Object.assign(env, original);
  setTransportFactory(null);
}

/** The platform sender (`SMTP_*` env) used in tests. Its From name and Reply-To must never reach a club's emails. */
export const PLATFORM_SMTP: SmtpEnv = {
  host: 'smtp.platform.test',
  port: 465,
  secure: true,
  user: 'resend',
  pass: 're_platform_key',
  fromEmail: 'bookings@mail.platform.test',
  fromName: 'Comedy Booking Platform',
  replyTo: 'noreply@platform.test',
};

export const TEST_APP_SECRET = 'test-app-secret-0123456789';

export function testHostedEnv(overrides: Partial<HostedEnv> = {}): HostedEnv {
  return {
    platformUrl: 'https://comedy.test',
    platformHost: 'comedy.test',
    protocol: 'https:',
    platformName: 'Comedy Booking',
    adminEmails: ['owner@comedy.test'],
    supportEmail: 'owner@comedy.test',
    signupsOpen: true,
    dailyEmailCap: 2000,
    ...overrides,
  };
}

/** Single-club mode with nothing in the env: no SMTP_* fallback, no APP_SECRET (plus `patch`). */
export function singleClubMode(patch: Partial<EmailEnv> = {}): void {
  setEnv({ hosted: null, smtp: null, appSecret: null, ...patch });
}

/** Hosted mode: PLATFORM_URL set, the platform sender configured, APP_SECRET set (plus `patch`). */
export function hostedMode(hosted: Partial<HostedEnv> = {}, patch: Partial<EmailEnv> = {}): void {
  setEnv({ hosted: testHostedEnv(hosted), smtp: PLATFORM_SMTP, appSecret: TEST_APP_SECRET, ...patch });
}

export interface CapturedMail extends SendMailOptions {
  /** The SMTP server (and login) it was handed to. */
  server: SmtpServer;
}

/**
 * Route every SMTP send to an in-memory list instead of the network. `impl` can throw to
 * fail a send, or never resolve to hang it.
 */
export function captureMail(impl?: (mail: CapturedMail) => Promise<unknown>): CapturedMail[] {
  const sent: CapturedMail[] = [];
  setTransportFactory((server) => ({
    sendMail: (async (mail: SendMailOptions) => {
      const captured = { ...mail, server: { ...server } };
      sent.push(captured);
      return impl ? impl(captured) : { messageId: `test-${sent.length}` };
    }) as never,
  }));
  return sent;
}
