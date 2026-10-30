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
 *   resolveSmtpHosts({ 'smtp.evil.test': ['127.0.0.1'] });  // what mailbox hosts resolve to
 *
 * In hosted mode mailbox hosts are resolved before sending (the SMTP host guard). Tests never
 * touch real DNS: `hostedMode` resolves every host to PUBLIC_TEST_ADDRESS unless told otherwise.
 */
import type { SendMailOptions } from 'nodemailer';
import { env, type Env, type HostedEnv, type SmtpEnv } from '../env';
import { setTransportFactory, type SmtpServer } from '../email/mailer';
import { setSmtpHostLookup } from '../email/smtpHostGuard';

type EmailEnv = Pick<Env, 'hosted' | 'smtp' | 'appSecret'>;

const original: EmailEnv = { hosted: env.hosted, smtp: env.smtp, appSecret: env.appSecret };

/** Override the email-related env fields (until `restoreEnv`). */
export function setEnv(patch: Partial<EmailEnv>): void {
  Object.assign(env, patch);
}

/** Put the env back as the process started, with the real SMTP transport and DNS lookup. */
export function restoreEnv(): void {
  Object.assign(env, original);
  setTransportFactory(null);
  setSmtpHostLookup(null);
}

/** A public address (TEST-NET-3, documentation only) that mailbox hosts resolve to in tests. */
export const PUBLIC_TEST_ADDRESS = '203.0.113.10';

/**
 * What SMTP hosts resolve to for the host guard: the listed hosts to their addresses, any
 * other to PUBLIC_TEST_ADDRESS. A host mapped to [] doesn't resolve (ENOTFOUND).
 */
export function resolveSmtpHosts(addresses: Record<string, string[]> = {}): void {
  setSmtpHostLookup(async (host) => {
    const found = addresses[host] ?? [PUBLIC_TEST_ADDRESS];
    if (found.length === 0) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
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

/**
 * Hosted mode: PLATFORM_URL set, the platform sender configured, APP_SECRET set (plus
 * `patch`), and mailbox hosts resolving to a public address (see `resolveSmtpHosts`).
 */
export function hostedMode(hosted: Partial<HostedEnv> = {}, patch: Partial<EmailEnv> = {}): void {
  setEnv({ hosted: testHostedEnv(hosted), smtp: PLATFORM_SMTP, appSecret: TEST_APP_SECRET, ...patch });
  resolveSmtpHosts();
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
