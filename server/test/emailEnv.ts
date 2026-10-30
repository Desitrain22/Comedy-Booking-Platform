/**
 * Test toolkit for email senders: run a test club database as a single club or as a hosted
 * club, set the email env, and capture what the mailer hands to SMTP.
 *
 * Whether a club is hosted comes from its database (server/lib/hosting.ts: the registry tags
 * each club database it opens), never from `env.hosted`, which stays null here as it does in
 * hosted test apps. `hostedMode(db)` tags a `makeTestApp()` database the way the registry
 * would, so its routes and the mailer behave as a hosted club's. For the full hosted stack
 * (host routing, registry, sign-up), use `makeHostedTestApp()` (./hosted.ts).
 *
 * `env.smtp` is the platform sender in both cases (production passes the same SMTP_* config
 * to the platform), and `env.appSecret` encrypts mailbox passwords: `env` is a plain object
 * read on every call, so tests set those fields directly. Restore in `afterEach`:
 *
 *   beforeEach(() => singleClubMode());           // no SMTP_* env, no APP_SECRET
 *   afterEach(() => restoreEnv());
 *
 *   hostedMode(t.db, { dailyEmailCap: 3 });       // a hosted club, the platform sender, APP_SECRET
 *   const sent = captureMail();                   // every sendMail call, with the server it used
 *   resolveSmtpHosts({ 'smtp.evil.test': ['127.0.0.1'] });  // what mailbox hosts resolve to
 *
 * For a hosted club, mailbox hosts are resolved before sending (the SMTP host guard). Tests
 * never touch real DNS: `hostedMode` resolves every host to PUBLIC_TEST_ADDRESS unless told
 * otherwise (call `resolveSmtpHosts` after it).
 */
import type { SendMailOptions } from 'nodemailer';
import type { Db } from '../db/client';
import { setTransportFactory, type SmtpServer } from '../email/mailer';
import { setSmtpHostLookup } from '../email/smtpHostGuard';
import { env, type Env, type HostedEnv, type SmtpEnv } from '../env';
import { setClubHosting } from '../lib/hosting';
import { updateSettings } from '../lib/settings';
import { TEST_HOSTED } from './hosted';

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

/** The slug `hostedMode` gives a test club: its address is TEST_CLUB_URL. */
export const TEST_CLUB_SLUG = 'club';
/** `http://club.localhost:3000` (http keeps the tests' plain session cookies). */
export const TEST_CLUB_URL = `${TEST_HOSTED.protocol}//${TEST_CLUB_SLUG}.${TEST_HOSTED.platformHost}`;

/**
 * Single-club mode with nothing in the env: no SMTP_* fallback, no APP_SECRET (plus `patch`).
 * Pass `db` to turn a database `hostedMode` tagged back into a single club.
 */
export function singleClubMode(patch: Partial<EmailEnv> = {}, db?: Db): void {
  setEnv({ hosted: null, smtp: null, appSecret: null, ...patch });
  if (db) setClubHosting(db, null);
}

/**
 * A hosted club: `db` tagged as the registry tags a club database (its app URL set to
 * TEST_CLUB_URL, as sign-up does), the platform sender configured, APP_SECRET set (plus
 * `patch`), and mailbox hosts resolving to a public address (see `resolveSmtpHosts`).
 */
export function hostedMode(db: Db, hosted: Partial<HostedEnv> = {}, patch: Partial<EmailEnv> = {}): void {
  setClubHosting(db, { hosted: { ...TEST_HOSTED, ...hosted }, clubId: 1, slug: TEST_CLUB_SLUG, clubUrl: TEST_CLUB_URL });
  updateSettings(db, { appUrl: TEST_CLUB_URL });
  setEnv({ hosted: null, smtp: PLATFORM_SMTP, appSecret: TEST_APP_SECRET, ...patch });
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
