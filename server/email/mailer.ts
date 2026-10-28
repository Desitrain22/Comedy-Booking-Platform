/**
 * Outgoing email. SMTP settings come from Settings (DB) first, then SMTP_* env vars.
 * With neither, mail goes to the **outbox**: stored in `email_log` with status `outbox`
 * and printed to the server console, so the app is fully usable without email.
 * Every message (sent, failed or outbox) is recorded in `email_log`.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailKind, EmailStatus } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { emailLog } from '../db/schema';
import { env } from '../env';
import { getSettings } from '../lib/settings';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: EmailKind;
  comedianId?: number | null;
}

export interface SendEmailResult {
  /** email_log row id */
  id: number;
  status: EmailStatus;
  error?: string;
}

export interface MailConfig {
  source: 'settings' | 'env';
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /** Formatted From header, e.g. `"The Laugh Track" <booking@laughtrack.com>` */
  from: string;
  replyTo: string;
}

function formatFrom(name: string, email: string): string {
  if (!email) return '';
  return name ? `"${name.replace(/"/g, "'")}" <${email}>` : email;
}

/** The SMTP config in effect, or null when email isn't configured (outbox mode). */
export function getMailConfig(db: DbOrTx): MailConfig | null {
  const s = getSettings(db);
  if (s.smtpHost.trim()) {
    return {
      source: 'settings',
      host: s.smtpHost.trim(),
      port: s.smtpPort,
      secure: s.smtpSecure,
      user: s.smtpUser,
      pass: s.smtpPass,
      from: formatFrom(s.fromName || s.clubName, s.fromEmail || s.smtpUser),
      replyTo: s.replyTo,
    };
  }
  if (env.smtp) {
    return {
      source: 'env',
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      user: env.smtp.user,
      pass: env.smtp.pass,
      from: formatFrom(env.smtp.fromName || s.fromName || s.clubName, env.smtp.fromEmail || s.fromEmail),
      replyTo: env.smtp.replyTo || s.replyTo,
    };
  }
  return null;
}

export function isEmailConfigured(db: DbOrTx): boolean {
  return getMailConfig(db) !== null;
}

// ---------------------------------------------------------------------------
// Transport (cached per config; injectable for tests)
// ---------------------------------------------------------------------------

type TransportFactory = (config: MailConfig) => Pick<Transporter, 'sendMail'>;

const defaultFactory: TransportFactory = (config) =>
  nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });

let transportFactory: TransportFactory = defaultFactory;
const transportCache = new Map<string, Pick<Transporter, 'sendMail'>>();

/** Tests: replace how SMTP transports are created (pass null to restore). */
export function setTransportFactory(factory: TransportFactory | null): void {
  transportFactory = factory ?? defaultFactory;
  transportCache.clear();
}

function getTransport(config: MailConfig) {
  const key = JSON.stringify([config.host, config.port, config.secure, config.user, config.pass]);
  let transport = transportCache.get(key);
  if (!transport) {
    transport = transportFactory(config);
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

function record(db: DbOrTx, input: SendEmailInput, status: EmailStatus, error?: string): number {
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
    })
    .returning({ id: emailLog.id })
    .get().id;
}

/**
 * Send (or outbox) one email and log it. Never throws: check `status`
 * (`sent` | `failed` | `outbox`) and `error`.
 */
export async function sendEmail(db: DbOrTx, input: SendEmailInput): Promise<SendEmailResult> {
  const config = getMailConfig(db);
  if (!config) {
    logOutbox(input);
    return { id: record(db, input, 'outbox'), status: 'outbox' };
  }
  try {
    await getTransport(config).sendMail({
      from: config.from || undefined,
      to: input.to,
      replyTo: config.replyTo || undefined,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    return { id: record(db, input, 'sent'), status: 'sent' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!env.isTest) console.error(`[email] failed to send "${input.subject}" to ${input.to}: ${error}`);
    return { id: record(db, input, 'failed', error), status: 'failed', error };
  }
}
