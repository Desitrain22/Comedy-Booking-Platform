/**
 * "Send test email" for the company sender (`POST /api/settings/test-email`) and a booker's
 * own mailbox (`POST /api/me/mailbox/test`): a readable hint for SMTP errors, and a backstop
 * timeout raced against the send.
 */
import { httpError } from '../lib/http';
import type { SendEmailResult } from './mailer';

/**
 * How long a test-email request waits for the SMTP server before giving up. A backstop:
 * the transport's own timeouts (`SMTP_TIMEOUTS`, 10s connect + 10s greeting, 20s idle)
 * normally fail first with a more specific error, which gets a hint like any other failure.
 */
export const TEST_EMAIL_TIMEOUT_MS = 25_000;

/** A plain-language next step for a raw SMTP error message. */
export function smtpErrorHint(error: string, server: { host: string; port: number }): string {
  const host = server.host.toLowerCase();
  const where = `${server.host}:${server.port}`;
  if (/private network address/i.test(error)) {
    return `"${server.host}" points inside a private network, which isn't allowed here. Use your email provider's SMTP server, like smtp.gmail.com.`;
  }
  if (/EAUTH|invalid login|535|534|username and password not accepted|authentication (failed|unsuccessful)|bad ?credentials|missing credentials/i.test(error)) {
    if (host.includes('gmail') || host.includes('google')) {
      return 'Gmail rejected the username or password. Gmail needs an App Password — your normal Google password won’t work. Turn on 2-Step Verification, create an App Password at myaccount.google.com/apppasswords, and paste the 16 letters as the password. The username is your full Gmail address.';
    }
    if (host.includes('resend')) {
      return 'Resend rejected the login. The username must be exactly "resend" and the password is an API key that starts with re_.';
    }
    if (host.includes('postmark')) {
      return 'Postmark rejected the login. Use your Server API token as both the username and the password.';
    }
    return 'The server rejected the username or password. Check them with your email provider (many providers need an app password or API key here, not your normal password).';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|EDNS/i.test(error)) {
    return `Couldn't find a server called "${server.host}". Check the spelling of the SMTP host.`;
  }
  if (/ECONNREFUSED/i.test(error)) {
    return `${where} refused the connection. Check the port — it's usually 465 (SSL/TLS) or 587 (STARTTLS).`;
  }
  if (/wrong version number|ssl routines|EPROTO|tls_validate|ssl3_get_record|unexpected eof/i.test(error)) {
    return 'The "secure connection" setting doesn\'t match the port. Turn it on for port 465, and off for port 587 (which upgrades with STARTTLS).';
  }
  if (/ETIMEDOUT|timed? ?out|greeting never received|ECONNRESET/i.test(error)) {
    return `Couldn't talk to ${where}. Check the host and port, and that your server's network allows outgoing email (some hosts block ports 25, 465 and 587).`;
  }
  if (/self[- ]signed|certificate|CERT_/i.test(error)) {
    return "The server's security certificate isn't trusted. Double-check the host name — it must match the provider's certificate.";
  }
  if (/sender|from address|not verified|domain|not allowed|550|553|554/i.test(error)) {
    return 'The server refused the From address. Make sure the From email is allowed by your provider (for example a verified sender or domain).';
  }
  return 'Double-check the host, port, username and password with your email provider.';
}

/** The hint when the platform sender's daily cap held an email back. */
export const DAILY_CAP_HINT =
  "Your club has sent today's maximum through the platform's sender; it starts again tomorrow. A mailbox you connect yourself isn't limited.";

/** The hint when the hosted platform sender fails: nothing the club can fix in its settings. */
export const PLATFORM_SENDER_HINT =
  "Emails go out through the platform's own sender, so there's nothing to fix in your settings. Try again in a few minutes, or contact support if it keeps happening.";

/**
 * Wait for a test send, at most TEST_EMAIL_TIMEOUT_MS. Resolves with a `sent`/`outbox`
 * result; a failure throws 502 `email_failed` `{ smtpError, hint, logId }` and no answer
 * in time throws 504 `email_timeout` `{ hint }`. `server` is where it was sent (for the
 * hints), or null when it went to the outbox; `platform` when that's the hosted platform
 * sender.
 */
export async function awaitTestEmail(
  sending: Promise<SendEmailResult>,
  server: { host: string; port: number } | null,
  options: { platform?: boolean } = {},
): Promise<SendEmailResult & { status: 'sent' | 'outbox' }> {
  const hintFor = (error: string) => {
    if (error.startsWith('Daily email limit reached')) return DAILY_CAP_HINT;
    if (options.platform) return PLATFORM_SENDER_HINT;
    return server ? smtpErrorHint(error, server) : undefined;
  };
  // A late result still lands in the email log; don't let it surface as an unhandled rejection.
  sending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), TEST_EMAIL_TIMEOUT_MS);
  });
  const result: SendEmailResult | 'timeout' = await Promise.race([sending, timeout]).finally(() => clearTimeout(timer));

  if (result === 'timeout') {
    const where = server ? `${server.host}:${server.port}` : 'the mail server';
    throw httpError(504, `No answer from ${where} after ${TEST_EMAIL_TIMEOUT_MS / 1000} seconds`, 'email_timeout', {
      hint: hintFor('ETIMEDOUT') ?? 'Check the host and port with your email provider.',
    });
  }
  if (result.status === 'failed') {
    const smtpError = result.error ?? 'Unknown error';
    throw httpError(502, `Couldn't send the test email: ${smtpError}`, 'email_failed', {
      smtpError,
      hint: hintFor(smtpError),
      logId: result.id,
    });
  }
  return { ...result, status: result.status };
}
