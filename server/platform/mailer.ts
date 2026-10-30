/**
 * Emails the platform itself sends (hosted mode): sign-up notices to the owner, "find my
 * club" lists, and (PR 3) owner-console sign-in codes. Not on behalf of a club, so they never
 * touch a club's email_log or its senders (server/email/mailer.ts does that).
 *
 * - With the platform SMTP (`SMTP_*` env) they go out as `"<platformName>" <SMTP_FROM_EMAIL>`.
 * - Without it they go to the **outbox**: printed to the console and logged with their body,
 *   so dev and e2e can read them from `platform_email_log`.
 *
 * Every message is logged to `platform_email_log` (sent rows keep no body: they can hold
 * sign-in links or codes). `send` never throws. An outbox row is written before `send`
 * returns its promise, so a handler that fires and forgets has already logged it.
 *
 *   platform.mailer.send({ to, kind: 'signup_notice', subject, text, html });
 *   await platform.mailer.flush();      // tests: wait for SMTP sends in flight
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { SMTP_TIMEOUTS } from '../email/mailer';
import type { HostedEnv, SmtpEnv } from '../env';
import type { PlatformDb } from './db';
import { platformEmailLog, type PlatformEmailKind } from './schema';

export interface PlatformEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: PlatformEmailKind;
}

export interface PlatformSendResult {
  /** platform_email_log row id */
  id: number;
  status: 'sent' | 'failed' | 'outbox';
  error?: string;
}

export type PlatformTransport = Pick<Transporter, 'sendMail'>;
/** How the SMTP transport is made (injectable for tests). */
export type PlatformTransportFactory = (smtp: SmtpEnv) => PlatformTransport;

export interface PlatformMailerOptions {
  db: PlatformDb;
  hosted: Pick<HostedEnv, 'platformName'>;
  /** The platform SMTP (`env.smtp`); null → outbox. */
  smtp: SmtpEnv | null;
  /** Default: nodemailer with the club mailer's timeouts. */
  transportFactory?: PlatformTransportFactory;
  /** Don't print outbox emails (default: printed unless running tests). */
  quiet?: boolean;
}

export interface PlatformMailer {
  /** Formatted From header, or null in outbox mode. */
  readonly from: string | null;
  send(email: PlatformEmail): Promise<PlatformSendResult>;
  /** Resolves once every send started so far has finished (tests, shutdown). */
  flush(): Promise<void>;
}

export function formatFrom(name: string, email: string): string {
  return name ? `"${name.replace(/["\\\r\n]/g, "'")}" <${email}>` : email;
}

const defaultTransportFactory: PlatformTransportFactory = (smtp) =>
  nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    ...SMTP_TIMEOUTS,
  });

function printOutbox(email: PlatformEmail): void {
  const rule = '─'.repeat(64);
  console.log(
    [
      '',
      `┌${rule}`,
      `│ 📬 PLATFORM OUTBOX (SMTP not configured): ${email.kind}`,
      `│ To:      ${email.to}`,
      `│ Subject: ${email.subject}`,
      `├${rule}`,
      ...email.text.split('\n').map((line) => `│ ${line}`),
      `└${rule}`,
      '',
    ].join('\n'),
  );
}

export function createPlatformMailer(options: PlatformMailerOptions): PlatformMailer {
  const { db, smtp } = options;
  const quiet = options.quiet ?? Boolean(process.env.VITEST);
  const from = smtp?.fromEmail ? formatFrom(options.hosted.platformName, smtp.fromEmail) : null;
  let transport: PlatformTransport | null = null;
  const inFlight = new Set<Promise<unknown>>();

  function record(email: PlatformEmail, status: PlatformSendResult['status'], error?: string): number {
    return db
      .insert(platformEmailLog)
      .values({
        toEmail: email.to,
        subject: email.subject,
        kind: email.kind,
        status,
        error: error ?? null,
        bodyText: status === 'outbox' ? email.text : '',
      })
      .returning({ id: platformEmailLog.id })
      .get().id;
  }

  async function deliver(email: PlatformEmail, config: SmtpEnv, fromHeader: string): Promise<PlatformSendResult> {
    try {
      transport ??= (options.transportFactory ?? defaultTransportFactory)(config);
      await transport.sendMail({ from: fromHeader, to: email.to, subject: email.subject, text: email.text, html: email.html });
      return { id: record(email, 'sent'), status: 'sent' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        return { id: record(email, 'failed', message), status: 'failed', error: message };
      } catch (logErr) {
        console.error('[platform-mailer] could not log a failed email', logErr);
        return { id: 0, status: 'failed', error: message };
      }
    }
  }

  return {
    from,
    send(email) {
      if (!smtp || !from) {
        try {
          if (!quiet) printOutbox(email);
          return Promise.resolve({ id: record(email, 'outbox'), status: 'outbox' });
        } catch (err) {
          console.error('[platform-mailer] could not log an outbox email', err);
          return Promise.resolve({ id: 0, status: 'failed', error: String(err) });
        }
      }
      const promise = deliver(email, smtp, from);
      inFlight.add(promise);
      void promise.finally(() => inFlight.delete(promise));
      return promise;
    },
    async flush() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
  };
}
