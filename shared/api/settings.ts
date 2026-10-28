/**
 * F6 Settings — API shapes shared by server/routes/settings.ts and client/pages/settings.
 *
 *   GET  /api/settings                   SettingsDto (never the SMTP password)
 *   PUT  /api/settings                   UpdateSettingsInput (partial) → SettingsDto
 *   POST /api/settings/test-email        { to? } → TestEmailResponse | 502 email_failed | 504 email_timeout
 *   GET  /api/email-log?q&kind&status&limit   EmailLogItem[] (newest first, default 100)
 *   GET  /api/email-log/:id              EmailLogDetail
 *   GET  /api/users                      BookerUserDto[]                      (admin)
 *   POST /api/users                      InviteUserInput → 201 InviteResponse (admin)
 *   PATCH /api/users/:id                 UpdateUserInput → BookerUserDto       (admin)
 *   DELETE /api/users/:id                → { ok: true }                         (admin)
 *   POST /api/users/:id/resend-invite    { sendEmail? } → InviteResponse        (admin)
 *   GET  /api/backup                     club-backup-YYYY-MM-DD.db (SQLite)     (admin)
 */
import { z } from 'zod';
import { AVAILABILITY_MAX_END, AVAILABILITY_MIN_START } from '../availability';
import { emailSchema, timeZoneSchema } from '../schemas';
import { EMAIL_KINDS, EMAIL_STATUSES, ROLES, type EmailKind, type EmailStatus, type Role } from '../types';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `GET /api/settings`. The SMTP password is write-only: only `smtpPassSet` is exposed. */
export interface SettingsDto {
  clubName: string;
  timezone: string;
  /** As saved ('' = fall back to the APP_URL env var / localhost). */
  appUrl: string;
  /** The base URL actually used for links in emails. */
  effectiveAppUrl: string;
  allNightStartMin: number;
  allNightEndMin: number;

  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  /** A password is saved (it is never sent back). */
  smtpPassSet: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  /** Some SMTP server is in effect (these settings or SMTP_* env vars). False → outbox. */
  emailConfigured: boolean;
  /** Where the SMTP config in effect comes from, or null in outbox mode. */
  emailSource: 'settings' | 'env' | null;
  /** Host in effect, e.g. `smtp.gmail.com` (null in outbox mode). */
  emailHost: string | null;
  /** Formatted From header in effect, e.g. `"The Laugh Track" <booking@club.com>`. */
  emailFrom: string | null;
  /** The most recent email actually handed to an SMTP server (outbox ignored), or null. */
  lastEmail: { id: number; status: 'sent' | 'failed'; error: string | null; createdAt: number } | null;

  confirmationsEnabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  confirmationDay: number;
  /** Minutes after local midnight, 0–1439. */
  confirmationTimeMin: number;
}

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** '' or a valid email (trimmed, lowercased). */
export const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address');

const allNightMinutes = z.number().int().min(AVAILABILITY_MIN_START).max(AVAILABILITY_MAX_END);

/**
 * `PUT /api/settings` — every field optional (each tab saves its own fields).
 * `smtpPass`: blank or omitted keeps the saved password; `clearSmtpPass: true` removes it.
 */
export const updateSettingsSchema = z
  .object({
    clubName: z.string().trim().min(1, 'Enter the club name').max(100),
    timezone: timeZoneSchema,
    appUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === '' || isHttpUrl(v), 'Enter a full address like https://booking.yourclub.com')
      .transform((v) => v.replace(/\/+$/, '')),
    allNightStartMin: allNightMinutes,
    allNightEndMin: allNightMinutes,

    smtpHost: z
      .string()
      .trim()
      .max(255)
      .refine((v) => v === '' || HOSTNAME_RE.test(v), 'Enter just the server name, like smtp.gmail.com'),
    smtpPort: z.number().int().min(1, 'Enter a port like 465 or 587').max(65535, 'Enter a port like 465 or 587'),
    smtpSecure: z.boolean(),
    smtpUser: z.string().trim().max(255),
    smtpPass: z.string().max(500),
    clearSmtpPass: z.boolean(),
    fromName: z.string().trim().max(100),
    fromEmail: optionalEmailSchema,
    replyTo: optionalEmailSchema,

    confirmationsEnabled: z.boolean(),
    confirmationDay: z.number().int().min(0).max(6),
    confirmationTimeMin: z.number().int().min(0).max(1439),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.allNightStartMin !== undefined && v.allNightEndMin !== undefined && v.allNightEndMin <= v.allNightStartMin) {
      ctx.addIssue({ code: 'custom', path: ['allNightEndMin'], message: 'All night must end after it starts' });
    }
  });
export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;

// ---------------------------------------------------------------------------
// Test email
// ---------------------------------------------------------------------------

/** `POST /api/settings/test-email` — `to` defaults to the signed-in booker's email. */
export const testEmailSchema = z.object({ to: emailSchema.optional() });
export type TestEmailInput = z.input<typeof testEmailSchema>;

/**
 * Success (`sent`, or `outbox` when email isn't configured). Failures are errors:
 * 502 `{ code: 'email_failed', error, smtpError, hint, logId }` or
 * 504 `{ code: 'email_timeout', error, hint }`.
 */
export interface TestEmailResponse {
  status: 'sent' | 'outbox';
  to: string;
  logId: number;
}

/** Extra fields on a failed test email's error body. */
export interface TestEmailErrorExtra {
  smtpError?: string;
  hint?: string;
  logId?: number;
}

// ---------------------------------------------------------------------------
// Email log
// ---------------------------------------------------------------------------

export const emailLogQuerySchema = z.object({
  /** Matches recipient or subject. */
  q: z.string().trim().max(200).optional(),
  kind: z.enum(EMAIL_KINDS).optional(),
  status: z.enum(EMAIL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type EmailLogQuery = z.input<typeof emailLogQuerySchema>;

export interface EmailLogItem {
  id: number;
  toEmail: string;
  subject: string;
  kind: EmailKind;
  status: EmailStatus;
  error: string | null;
  comedianId: number | null;
  createdAt: number;
}

export interface EmailLogDetail extends EmailLogItem {
  bodyHtml: string;
  bodyText: string;
}

export const EMAIL_KIND_LABELS: Record<EmailKind, string> = {
  login_code: 'Sign-in code',
  login_link: 'Sign-in link',
  availability_request: 'Availability request',
  availability_reminder: 'Availability reminder',
  confirmation: 'Confirmation',
  booker_invite: 'Booker invite',
  test: 'Test',
};

export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  sent: 'Sent',
  failed: 'Failed',
  outbox: 'Outbox',
};

// ---------------------------------------------------------------------------
// Bookers (users)
// ---------------------------------------------------------------------------

/** `active` = has a password; `invited` = live invite; `invite_expired` = invite ran out. */
export type BookerUserStatus = 'active' | 'invited' | 'invite_expired';

export interface BookerUserDto {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: BookerUserStatus;
  inviteExpiresAt: number | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export const inviteUserSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  email: emailSchema,
  role: z.enum(ROLES).default('booker'),
  /** Email the invite link (default true). The link is returned either way. */
  sendEmail: z.boolean().default(true),
});
export type InviteUserInput = z.input<typeof inviteUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(100),
    role: z.enum(ROLES),
  })
  .partial();
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export const resendInviteSchema = z.object({ sendEmail: z.boolean().default(true) });
export type ResendInviteInput = z.input<typeof resendInviteSchema>;

/** `POST /api/users` and `POST /api/users/:id/resend-invite`. */
export interface InviteResponse {
  user: BookerUserDto;
  /** Absolute `/accept-invite/<token>` link — show it so it can be copied. */
  inviteUrl: string;
  email: { status: EmailStatus | 'skipped'; error?: string };
}
