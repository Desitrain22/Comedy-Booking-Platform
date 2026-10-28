/**
 * SMTP provider presets for Settings → Email, plus small pure helpers for the email log.
 * Kept free of React so they can be unit-tested.
 */

export type EmailProviderId = 'gmail' | 'resend' | 'postmark' | 'custom';

export interface EmailProvider {
  id: EmailProviderId;
  label: string;
  /** One line under the label in the picker. */
  tagline: string;
  host: string;
  port: number;
  secure: boolean;
  /** Username that is always the same for this provider (Resend: `resend`). */
  fixedUser?: string;
  /** The provider uses one token as both username and password (Postmark). */
  tokenAsUserAndPass?: boolean;
  userLabel: string;
  userPlaceholder: string;
  passLabel: string;
  passPlaceholder: string;
  /** Strip spaces from the password (Google shows App Passwords as "abcd efgh ijkl mnop"). */
  stripPassSpaces?: boolean;
}

export const EMAIL_PROVIDERS: readonly EmailProvider[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    tagline: 'Send from a Google account',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    userLabel: 'Gmail address',
    userPlaceholder: 'bookings@yourclub.com',
    passLabel: 'App Password',
    passPlaceholder: 'abcd efgh ijkl mnop',
    stripPassSpaces: true,
  },
  {
    id: 'resend',
    label: 'Resend',
    tagline: 'Email service with a free tier',
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    fixedUser: 'resend',
    userLabel: 'Username',
    userPlaceholder: 'resend',
    passLabel: 'API key',
    passPlaceholder: 're_…',
  },
  {
    id: 'postmark',
    label: 'Postmark',
    tagline: 'Reliable transactional email',
    host: 'smtp.postmarkapp.com',
    port: 587,
    secure: false,
    tokenAsUserAndPass: true,
    userLabel: 'Server API token',
    userPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    passLabel: 'Server API token',
    passPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
  {
    id: 'custom',
    label: 'Other SMTP server',
    tagline: 'Outlook, Fastmail, SendGrid, Mailgun…',
    host: '',
    port: 587,
    secure: false,
    userLabel: 'Username',
    userPlaceholder: 'Usually your email address',
    passLabel: 'Password',
    passPlaceholder: 'Password or app password',
  },
];

export function getEmailProvider(id: EmailProviderId): EmailProvider {
  return EMAIL_PROVIDERS.find((p) => p.id === id)!;
}

/** Which preset a saved host belongs to: a preset id, `custom`, or null when blank. */
export function detectEmailProvider(host: string): EmailProviderId | null {
  const h = host.trim().toLowerCase();
  if (!h) return null;
  return EMAIL_PROVIDERS.find((p) => p.host && p.host === h)?.id ?? 'custom';
}

/** The usual security setting for a port: 465 is implicit TLS, others use STARTTLS. */
export function secureForPort(port: number): boolean | null {
  if (port === 465) return true;
  if (port === 587 || port === 25 || port === 2525) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Email log helpers
// ---------------------------------------------------------------------------

/** The 6-digit sign-in code in a login-code email's text, if any. */
export function extractLoginCode(text: string): string | null {
  return /\b(\d{6})\b/.exec(text)?.[1] ?? null;
}

/** Distinct http(s) links in an email's plain text, in order. */
export function extractLinks(text: string): string[] {
  const links = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return [...new Set(links.map((l) => l.replace(/[.,;:!?]+$/, '')))];
}

/**
 * The email HTML for a sandboxed preview iframe: links open in a new tab (the iframe
 * itself can't navigate anywhere useful), nothing else is changed.
 */
export function previewDocument(html: string): string {
  const base = '<base target="_blank">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  return `<!doctype html><html><head>${base}<meta charset="utf-8"></head><body>${html}</body></html>`;
}
