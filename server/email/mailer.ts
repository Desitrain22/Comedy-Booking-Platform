/**
 * Outgoing email. Every message (sent, failed or outbox) is recorded in `email_log`, with
 * how it went out (`via`) and the booker it was sent for (`senderUserId`).
 *
 * Who a message comes from (hosted MVP spec §5). `sendEmail` takes an optional
 * `senderUserId`; with `settings.senderMode = 'booker'` that booker is the sender,
 * otherwise (and for sign-in codes, magic links and invites, which pass none) the company:
 *
 *   sender     connected mailbox                   goes out as                                   Reply-To
 *   company    company mailbox (Settings → Email)  "<fromName‖club>" <mailbox address>           company email ‖ (mailbox address)
 *   company    none, platform sender (SMTP_* env)  "<club>" <SMTP_FROM_EMAIL>                    company email ‖ first admin
 *   booker U   U's own mailbox (Settings → Account) "<U.name> · <club>" <U's mailbox address>     U.email
 *   booker U   none, company mailbox               "<U.name> · <club>" <company mailbox address> U.email
 *   booker U   neither, platform sender            "<U.name> · <club>" <SMTP_FROM_EMAIL>         U.email
 *   any        nothing configured                  outbox: stored in email_log, printed to the console
 *
 * The SMTP_* env sender is "the platform sender" in hosted mode (PLATFORM_URL set): there
 * its SMTP_FROM_NAME and SMTP_REPLY_TO never override the club's names or company email,
 * company sends always carry a Reply-To that reaches a person, and a club may send at most
 * PLATFORM_DAILY_EMAIL_CAP of them per club-local day (mailboxes a club connects itself
 * don't count). In single-club mode the env sender is the club's own fallback and keeps its
 * original behaviour (SMTP_FROM_NAME / SMTP_REPLY_TO win, no cap).
 *
 * Mailbox passwords are stored encrypted when APP_SECRET is set (server/lib/secrets.ts). In
 * hosted mode, mailboxes a club or booker connects must resolve to public addresses only
 * (./smtpHostGuard.ts): checked before every send, and the connection goes to the vetted IP.
 */
import { and, asc, count, eq, gte, isNotNull, lt } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailVia, SenderMode, SenderPreview } from '../../shared/api/settings';
import { addDays, zonedTimeToUtc } from '../../shared/time';
import type { EmailKind, EmailStatus } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { emailLog, users, type Settings, type User } from '../db/schema';
import { env } from '../env';
import { decryptSecret } from '../lib/secrets';
import { clubToday, getSettings } from '../lib/settings';
import { vetSmtpHost } from './smtpHostGuard';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: EmailKind;
  comedianId?: number | null;
  /** Reply-To for this message, overriding the resolved one. */
  replyTo?: string;
  /**
   * The booker this message is from: who sent the availability request, or who booked every
   * spot in a confirmation. Omitted/null = the company. It only changes From and Reply-To
   * when the club's senderMode is `booker`, but it is recorded on the email_log row either way.
   */
  senderUserId?: number | null;
  /**
   * Replies must reach a person (confirmations: "Can't make one? Reply to this email"): a
   * company send with no company email gets Reply-To = the club's first admin.
   */
  replyToPerson?: boolean;
  /** Resolve the sender as if settings.senderMode were this (the booker mailbox test). */
  senderMode?: SenderMode;
}

export interface SendEmailResult {
  /** email_log row id */
  id: number;
  status: EmailStatus;
  error?: string;
}

/** One SMTP server and its login (password decrypted). */
export interface SmtpServer {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /**
   * Connect to this IP instead of resolving `host` again (hosted mode: the address the host
   * guard vetted). `host` still names the server for TLS (SNI and the certificate check).
   */
  address?: string;
}

/** The company's sender in effect: what sign-in codes, invites and company emails go out through. */
export interface MailConfig extends SmtpServer {
  /**
   * `settings`: the company mailbox (Settings → Email). `env`: the SMTP_* variables, as the
   * single-club fallback. `platform`: the SMTP_* variables as the hosted platform sender.
   */
  source: 'settings' | 'env' | 'platform';
  via: 'company-mailbox' | 'platform';
  fromName: string;
  fromEmail: string;
  /** Formatted From header, e.g. `"The Laugh Track" <booking@laughtrack.com>` */
  from: string;
  /** Reply-To for company emails ('' = none, replies go to the From address). */
  replyTo: string;
  /** The saved password can't be read (APP_SECRET changed): sends through it fail with this. */
  passError?: string;
}

/** Who one message goes out as, and through what. */
export interface ResolvedSender {
  via: EmailVia;
  /** Where it's handed over; null = the outbox. */
  server: SmtpServer | null;
  fromName: string;
  fromEmail: string;
  /** Formatted From header ('' in outbox mode). */
  from: string;
  /** Reply-To header ('' = none: replies go to the From address). */
  replyTo: string;
  /** The booker it goes out as (senderMode `booker`); null = the company. */
  asBooker: Pick<User, 'id' | 'name' | 'email'> | null;
  /** What to record as `email_log.senderUserId`: the given booker when they exist, in either mode. */
  senderUserId: number | null;
  /** Set when the mailbox password can't be read: the send fails with this. */
  error?: string;
}

export interface ResolveSenderOptions {
  senderUserId?: number | null;
  /** Resolve as if settings.senderMode were this. */
  senderMode?: SenderMode;
  replyToPerson?: boolean;
}

function formatFrom(name: string, email: string): string {
  if (!email) return '';
  return name ? `"${name.replace(/"/g, "'")}" <${email}>` : email;
}

/** A stored mailbox password, decrypted; `error` when it can't be read. */
function readPassword(stored: string): { pass: string; error?: string } {
  try {
    return { pass: decryptSecret(stored) };
  } catch (err) {
    return { pass: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function firstAdminEmail(db: DbOrTx): string {
  const admin = db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNotNull(users.passwordHash)))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1)
    .get();
  return admin?.email ?? '';
}

function companyMailbox(s: Settings): MailConfig | null {
  if (!s.smtpHost.trim()) return null;
  const { pass, error } = readPassword(s.smtpPass);
  const fromName = s.fromName || s.clubName;
  const fromEmail = s.fromEmail || s.smtpUser;
  return {
    source: 'settings',
    via: 'company-mailbox',
    host: s.smtpHost.trim(),
    port: s.smtpPort,
    secure: s.smtpSecure,
    user: s.smtpUser,
    pass,
    ...(error ? { passError: error } : {}),
    fromName,
    fromEmail,
    from: formatFrom(fromName, fromEmail),
    replyTo: s.replyTo,
  };
}

function envSender(db: DbOrTx, s: Settings): MailConfig | null {
  const smtp = env.smtp;
  if (!smtp) return null;
  const server = { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass };
  if (env.hosted) {
    // The platform sender: the club's own name and company email, never the platform's.
    const fromName = s.clubName || env.hosted.platformName;
    return {
      source: 'platform',
      via: 'platform',
      ...server,
      fromName,
      fromEmail: smtp.fromEmail,
      from: formatFrom(fromName, smtp.fromEmail),
      replyTo: s.replyTo.trim() || firstAdminEmail(db),
    };
  }
  // Single-club fallback, as it always was: the env's From name and Reply-To win.
  const fromName = smtp.fromName || s.fromName || s.clubName;
  const fromEmail = smtp.fromEmail || s.fromEmail;
  return {
    source: 'env',
    via: 'platform',
    ...server,
    fromName,
    fromEmail,
    from: formatFrom(fromName, fromEmail),
    replyTo: smtp.replyTo || s.replyTo,
  };
}

function mailConfigFor(db: DbOrTx, s: Settings): MailConfig | null {
  return companyMailbox(s) ?? envSender(db, s);
}

/** The company's sender in effect, or null when email isn't configured (outbox mode). */
export function getMailConfig(db: DbOrTx): MailConfig | null {
  return mailConfigFor(db, getSettings(db));
}

/** Company emails reach inboxes (a company mailbox, or the SMTP_* / platform sender). */
export function isEmailConfigured(db: DbOrTx): boolean {
  return getMailConfig(db) !== null;
}

/**
 * Reply-To that always reaches a person, for company emails: the company email
 * (settings.replyTo, or SMTP_REPLY_TO in single-club mode), else the email of the club's
 * first admin who has signed up, else ''.
 */
export function replyToWithAdminFallback(db: DbOrTx): string {
  const configured = (getMailConfig(db)?.replyTo ?? getSettings(db).replyTo).trim();
  return configured || firstAdminEmail(db);
}

/** A booker's own mailbox (Settings → Account), or null when they haven't connected one. */
export function bookerMailbox(
  user: Pick<User, 'smtpHost' | 'smtpPort' | 'smtpSecure' | 'smtpUser' | 'smtpPass' | 'smtpFromEmail'>,
): (SmtpServer & { fromEmail: string; passError?: string }) | null {
  if (!user.smtpHost.trim()) return null;
  const { pass, error } = readPassword(user.smtpPass);
  return {
    host: user.smtpHost.trim(),
    port: user.smtpPort,
    secure: user.smtpSecure,
    user: user.smtpUser,
    pass,
    fromEmail: user.smtpFromEmail || user.smtpUser,
    ...(error ? { passError: error } : {}),
  };
}

function serverOf(config: SmtpServer): SmtpServer {
  return { host: config.host, port: config.port, secure: config.secure, user: config.user, pass: config.pass };
}

/** "Rich Brooks · Broadway Comedy" */
export function bookerFromName(bookerName: string, clubName: string): string {
  return clubName ? `${bookerName} · ${clubName}` : bookerName;
}

/** Who a message goes out as and through which server (see the table at the top). */
export function resolveSender(db: DbOrTx, options: ResolveSenderOptions = {}): ResolvedSender {
  const s = getSettings(db);
  const company = mailConfigFor(db, s);
  const user =
    options.senderUserId != null ? db.select().from(users).where(eq(users.id, options.senderUserId)).get() : undefined;
  const senderUserId = user?.id ?? null;
  const mode = options.senderMode ?? s.senderMode;

  if (user && mode === 'booker') {
    const asBooker = { id: user.id, name: user.name, email: user.email };
    const fromName = bookerFromName(user.name, s.clubName);
    const own = bookerMailbox(user);
    if (own) {
      return {
        via: 'booker-mailbox',
        server: serverOf(own),
        fromName,
        fromEmail: own.fromEmail,
        from: formatFrom(fromName, own.fromEmail),
        replyTo: user.email,
        asBooker,
        senderUserId,
        ...(own.passError ? { error: own.passError } : {}),
      };
    }
    if (company) {
      return {
        via: company.via,
        server: serverOf(company),
        fromName,
        fromEmail: company.fromEmail,
        from: formatFrom(fromName, company.fromEmail),
        replyTo: user.email,
        asBooker,
        senderUserId,
        ...(company.passError ? { error: company.passError } : {}),
      };
    }
    return { via: 'outbox', server: null, fromName, fromEmail: '', from: '', replyTo: user.email, asBooker, senderUserId };
  }

  if (!company) {
    return { via: 'outbox', server: null, fromName: '', fromEmail: '', from: '', replyTo: '', asBooker: null, senderUserId };
  }
  return {
    via: company.via,
    server: serverOf(company),
    fromName: company.fromName,
    fromEmail: company.fromEmail,
    from: company.from,
    replyTo: company.replyTo.trim() || (options.replyToPerson ? firstAdminEmail(db) : ''),
    asBooker: null,
    senderUserId,
    ...(company.passError ? { error: company.passError } : {}),
  };
}

/** What comedians would see (From and where replies go), or null in outbox mode. */
export function previewSender(db: DbOrTx, options: ResolveSenderOptions = {}): SenderPreview | null {
  const sender = resolveSender(db, options);
  if (sender.via === 'outbox') return null;
  return {
    via: sender.via,
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    replyTo: sender.replyTo || sender.fromEmail,
  };
}

// ---------------------------------------------------------------------------
// Daily cap on the platform sender (hosted mode)
// ---------------------------------------------------------------------------

/** The email_log error for a message held back by the daily cap. */
export function dailyCapError(cap: number): string {
  return `Daily email limit reached (${cap} per day) — contact support`;
}

/** Platform-sender emails this club sent today (its own timezone's calendar day). */
export function platformEmailsSentToday(db: DbOrTx, now: Date = new Date()): number {
  const timeZone = getSettings(db).timezone;
  const today = clubToday(db, now);
  const start = zonedTimeToUtc(today, 0, timeZone);
  const end = zonedTimeToUtc(addDays(today, 1), 0, timeZone);
  return (
    db
      .select({ n: count() })
      .from(emailLog)
      .where(
        and(
          eq(emailLog.via, 'platform'),
          eq(emailLog.status, 'sent'),
          gte(emailLog.createdAt, start),
          lt(emailLog.createdAt, end),
        ),
      )
      .get()?.n ?? 0
  );
}

/** Platform sends handed to SMTP but not logged yet, per database (a blast sends a few at once). */
const platformInFlight = new WeakMap<object, number>();

function adjustInFlight(db: DbOrTx, delta: number): void {
  const next = (platformInFlight.get(db) ?? 0) + delta;
  if (next > 0) platformInFlight.set(db, next);
  else platformInFlight.delete(db);
}

/** The cap error when this club can't send another platform email today, else null. */
function platformCapReached(db: DbOrTx): string | null {
  if (!env.hosted) return null;
  const cap = env.hosted.dailyEmailCap;
  const used = platformEmailsSentToday(db) + (platformInFlight.get(db) ?? 0);
  return used >= cap ? dailyCapError(cap) : null;
}

// ---------------------------------------------------------------------------
// Transport (cached per server and login; injectable for tests)
// ---------------------------------------------------------------------------

type TransportFactory = (config: SmtpServer) => Pick<Transporter, 'sendMail'>;

/**
 * SMTP timeouts (ms). nodemailer's defaults wait up to 2 minutes to connect, so one wrong
 * host would stall a whole weekly confirmation run; these fail each message fast instead.
 * The test-email routes (server/routes/settings.ts, mailbox.ts) race their own longer
 * timeout on top.
 */
export const SMTP_TIMEOUTS = {
  /** Opening the TCP/TLS connection. */
  connectionTimeout: 10_000,
  /** Waiting for the server's greeting once connected. */
  greetingTimeout: 10_000,
  /** Silence on an open connection. */
  socketTimeout: 20_000,
} as const;

/** nodemailer transport options for a server (exported for tests). */
export function smtpTransportOptions(config: SmtpServer) {
  return {
    host: config.address ?? config.host,
    ...(config.address ? { servername: config.host } : {}),
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    ...SMTP_TIMEOUTS,
  };
}

const defaultFactory: TransportFactory = (config) => nodemailer.createTransport(smtpTransportOptions(config));

let transportFactory: TransportFactory = defaultFactory;
/** Insertion-ordered, so the oldest entry goes first when it's full (one per mailbox in use). */
const transportCache = new Map<string, Pick<Transporter, 'sendMail'>>();
const TRANSPORT_CACHE_MAX = 50;

/** Tests: replace how SMTP transports are created (pass null to restore). */
export function setTransportFactory(factory: TransportFactory | null): void {
  transportFactory = factory ?? defaultFactory;
  transportCache.clear();
}

function getTransport(config: SmtpServer) {
  const key = JSON.stringify([config.host, config.address, config.port, config.secure, config.user, config.pass]);
  let transport = transportCache.get(key);
  if (!transport) {
    transport = transportFactory(config);
    if (transportCache.size >= TRANSPORT_CACHE_MAX) transportCache.delete(transportCache.keys().next().value!);
    transportCache.set(key, transport);
  }
  return transport;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function logOutbox(input: SendEmailInput): void {
  if (env.isTest) return;
  const rule = '─'.repeat(64);
  console.log(
    [
      '',
      `┌${rule}`,
      `│ 📬 OUTBOX (email not configured): ${input.kind}`,
      `│ To:      ${input.to}`,
      `│ Subject: ${input.subject}`,
      `├${rule}`,
      ...input.text.split('\n').map((line) => `│ ${line}`),
      `└${rule}`,
      '',
    ].join('\n'),
  );
}

function record(
  db: DbOrTx,
  input: SendEmailInput,
  sender: ResolvedSender,
  status: EmailStatus,
  error?: string,
): number {
  return db
    .insert(emailLog)
    .values({
      toEmail: input.to,
      subject: input.subject,
      kind: input.kind,
      status,
      error: error ?? null,
      comedianId: input.comedianId ?? null,
      bodyHtml: input.html,
      bodyText: input.text,
      via: sender.via,
      senderUserId: sender.senderUserId,
    })
    .returning({ id: emailLog.id })
    .get().id;
}

function failed(db: DbOrTx, input: SendEmailInput, sender: ResolvedSender, error: string): SendEmailResult {
  if (!env.isTest) console.error(`[email] failed to send "${input.subject}" to ${input.to}: ${error}`);
  return { id: record(db, input, sender, 'failed', error), status: 'failed', error };
}

/**
 * Send (or outbox) one email and log it. Never throws: check `status`
 * (`sent` | `failed` | `outbox`) and `error`.
 */
export async function sendEmail(db: DbOrTx, input: SendEmailInput): Promise<SendEmailResult> {
  const sender = resolveSender(db, input);
  if (!sender.server) {
    logOutbox(input);
    return { id: record(db, input, sender, 'outbox'), status: 'outbox' };
  }
  if (sender.error) return failed(db, input, sender, sender.error);
  let server = sender.server;
  // Hosted mode: a mailbox someone connected must resolve to public addresses only (the
  // platform's own sender is trusted). Refused hosts never get a connection.
  if (env.hosted && (sender.via === 'company-mailbox' || sender.via === 'booker-mailbox')) {
    const vetted = await vetSmtpHost(server.host);
    if ('error' in vetted) return failed(db, input, sender, vetted.error);
    server = { ...server, address: vetted.address };
  }
  const isPlatform = sender.via === 'platform';
  if (isPlatform) {
    const capped = platformCapReached(db);
    if (capped) return failed(db, input, sender, capped);
    adjustInFlight(db, 1);
  }
  try {
    await getTransport(server).sendMail({
      from: sender.from || undefined,
      to: input.to,
      replyTo: input.replyTo || sender.replyTo || undefined,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    return { id: record(db, input, sender, 'sent'), status: 'sent' };
  } catch (err) {
    return failed(db, input, sender, err instanceof Error ? err.message : String(err));
  } finally {
    if (isPlatform) adjustInFlight(db, -1);
  }
}
