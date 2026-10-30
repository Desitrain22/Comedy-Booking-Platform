/**
 * F6 Settings — API shapes shared by server/routes/settings.ts and client/pages/settings.
 *
 *   GET  /api/settings                   SettingsDto (never the SMTP password)
 *   PUT  /api/settings                   UpdateSettingsInput (partial) → SettingsDto; changing an
 *                                        ADMIN_ONLY_SETTINGS field as a non-admin → 403 admin_only
 *   POST /api/settings/test-email        { to? } → TestEmailResponse | 502 email_failed | 504 email_timeout
 *                                        (non-admins: only to themselves, else 403 forbidden)
 *                                        Hosted mode: changing appUrl → 400 app_url_locked
 *   GET    /api/me/mailbox               MailboxDto (the signed-in booker's own mailbox; never the password)
 *   PUT    /api/me/mailbox               UpdateMailboxInput → MailboxDto (blank smtpPass keeps the saved one)
 *                                        | 400 from_email_required
 *   DELETE /api/me/mailbox               → MailboxDto (disconnected)
 *   POST   /api/me/mailbox/test          → TestEmailResponse (to yourself, through your mailbox)
 *                                        | 409 mailbox_not_connected | 502 email_failed | 504 email_timeout
 *   POST /api/auth/password              ChangePasswordInput → { ok: true } (signed-in booker; signs
 *                                        out their other sessions) | 400 wrong_password | 429 rate_limited
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
import { emailSchema, passwordSchema, timeZoneSchema } from '../schemas';
import { EMAIL_KINDS, EMAIL_STATUSES, ROLES, type EmailKind, type EmailStatus, type Role } from '../types';

// ---------------------------------------------------------------------------
// Who emails come from (hosted MVP spec §5)
// ---------------------------------------------------------------------------

/**
 * `company`: every email comes from the company. `booker`: availability requests come from
 * the booker who sent them, confirmations from the booker who booked every spot in them.
 * Sign-in codes, magic links and invites always come from the company.
 */
export const SENDER_MODES = ['company', 'booker'] as const;
export type SenderMode = (typeof SENDER_MODES)[number];

/**
 * How an email went out: the company's connected mailbox (Settings → Email), a booker's own
 * mailbox (Settings → Account), the platform sender (hosted mode, or the server's SMTP_*
 * variables) or the outbox (nothing configured).
 */
export const EMAIL_VIAS = ['company-mailbox', 'booker-mailbox', 'platform', 'outbox'] as const;
export type EmailVia = (typeof EMAIL_VIAS)[number];

export const EMAIL_VIA_LABELS: Record<EmailVia, string> = {
  'company-mailbox': 'Company mailbox',
  'booker-mailbox': "Booker's mailbox",
  platform: 'Platform sender',
  outbox: 'Outbox',
};

/** What comedians see on an email: `From: "<fromName>" <fromEmail>`, replies to `replyTo`. */
export interface SenderPreview {
  via: Exclude<EmailVia, 'outbox'>;
  fromName: string;
  fromEmail: string;
  /** Where replies go: the Reply-To, or the From address when there is none. */
  replyTo: string;
}

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
  /** The company email ("Company email" in the UI): replies to company emails go here. */
  replyTo: string;
  /** Who emails come from: the company, or each booker (spec §5). Admin-only to change. */
  senderMode: SenderMode;
  /**
   * Some SMTP server is in effect for company emails (the company mailbox, SMTP_* env vars or
   * the hosted platform sender). False → outbox.
   */
  emailConfigured: boolean;
  /**
   * Where the SMTP config in effect comes from, or null in outbox mode: `settings` = the
   * company mailbox, `env` = SMTP_* env vars (single-club), `platform` = the hosted platform
   * sender.
   */
  emailSource: 'settings' | 'env' | 'platform' | null;
  /** Host in effect, e.g. `smtp.gmail.com` (null in outbox mode). */
  emailHost: string | null;
  /** Formatted From header in effect, e.g. `"The Laugh Track" <booking@club.com>`. */
  emailFrom: string | null;
  /** The most recent email actually handed to an SMTP server (outbox ignored), or null. */
  lastEmail: { id: number; status: 'sent' | 'failed'; error: string | null; createdAt: number } | null;
  /**
   * Hosted mode: the platform sender every club can use without setup (null in single-club
   * mode, or when the server has no SMTP_* sender). Emails go out through it when no mailbox
   * is connected.
   */
  platformSender: { fromEmail: string } | null;
  /** What comedians see on company emails (sign-in links, invites, company mode), or null (outbox). */
  senderPreview: SenderPreview | null;
  /**
   * What comedians would see on emails from the signed-in booker with "Each booker" chosen
   * (whatever the saved senderMode), or null (outbox). Lets the form preview the choice.
   */
  bookerSenderPreview: SenderPreview | null;
  /** Hosted mode: the app address is the club's own and can't be changed here. */
  appUrlLocked: boolean;

  confirmationsEnabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  confirmationDay: number;
  /** Minutes after local midnight, 0–1439. */
  confirmationTimeMin: number;
  /**
   * Daily catch-up (default on): every day at confirmationTimeMin, email comedians with
   * spots this week (Mon–Sun) that haven't been emailed yet (booked after the weekly send).
   */
  catchUpEnabled: boolean;
  /**
   * Comedians can decline single spots ("Can't make it") in the portal and the
   * confirmation email (default off = confirm the whole week or reply to the email).
   */
  allowDeclines: boolean;
  /**
   * Mondays (this week on) whose automatic send already ran. Settings → Confirmations uses
   * it to show a missed send that goes out right after saving (the scheduler catches up any
   * due send whose week isn't over).
   */
  confirmationWeeksSent: string[];
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
    senderMode: z.enum(SENDER_MODES),

    confirmationsEnabled: z.boolean(),
    confirmationDay: z.number().int().min(0).max(6),
    confirmationTimeMin: z.number().int().min(0).max(1439),
    catchUpEnabled: z.boolean(),
    allowDeclines: z.boolean(),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.allNightStartMin !== undefined && v.allNightEndMin !== undefined && v.allNightEndMin <= v.allNightStartMin) {
      ctx.addIssue({ code: 'custom', path: ['allNightEndMin'], message: 'All night must end after it starts' });
    }
  });
export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;

/**
 * Settings only admins may change. They decide where every email goes and where its links
 * point (sign-in links, confirmations, invites), and they hold the SMTP password, so a
 * booker account must not be able to redirect them. Bookers can still save other fields;
 * sending one of these unchanged is fine.
 */
export const ADMIN_ONLY_SETTINGS = [
  'appUrl',
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUser',
  'smtpPass',
  'clearSmtpPass',
  'fromName',
  'fromEmail',
  'replyTo',
  'senderMode',
] as const satisfies readonly (keyof UpdateSettingsInput)[];
export type AdminOnlySetting = (typeof ADMIN_ONLY_SETTINGS)[number];

/**
 * Where the SMTP password is sent. Changing any of these without giving the password again
 * removes the saved one, so it's never handed to a server it wasn't entered for.
 */
export const SMTP_CONNECTION_FIELDS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser'] as const satisfies readonly (
  keyof SettingsDto
)[];

// ---------------------------------------------------------------------------
// Account (the signed-in booker)
// ---------------------------------------------------------------------------

/** `POST /api/auth/password`: change your own password (other sessions are signed out). */
export const changePasswordSchema = z
  .object({
    current: z.string().min(1, 'Enter your current password').max(200),
    next: passwordSchema,
  })
  .refine((v) => v.next !== v.current, { path: ['next'], message: 'Choose a new password, not your current one' });
export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

/** `POST /api/auth/password` success. */
export interface ChangePasswordResponse {
  ok: true;
  /** How many other sessions (devices) were signed out. */
  signedOut: number;
}

// ---------------------------------------------------------------------------
// Your mailbox (each booker's own SMTP, Settings → Account)
// ---------------------------------------------------------------------------

/**
 * `GET /api/me/mailbox`: the signed-in booker's own mailbox. With senderMode `booker`,
 * emails sent as them go out through it (else through the company's). Only they can see
 * or change it; the password is write-only (`smtpPassSet`).
 */
export interface MailboxDto {
  /** A server is saved (smtpHost isn't blank). */
  connected: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  /** A password is saved (it is never sent back). */
  smtpPassSet: boolean;
  /** Address it sends as ('' = smtpUser). */
  smtpFromEmail: string;
  /** The club's setting: in `booker` mode your availability requests and confirmations come from you. */
  senderMode: SenderMode;
  /** What comedians see on emails from you (as with "Each booker"), or null (outbox). */
  preview: SenderPreview | null;
  /** The latest email that went out through this mailbox (sent or failed), or null. */
  lastEmail: { id: number; status: 'sent' | 'failed'; error: string | null; createdAt: number } | null;
}

/**
 * `PUT /api/me/mailbox`: connect or change your mailbox. `smtpPass` blank or omitted keeps
 * the saved one, unless the server, port, security or username changed (then it's removed,
 * so it's never sent to a server it wasn't entered for); `clearSmtpPass` removes it.
 */
export const updateMailboxSchema = z.object({
  smtpHost: z
    .string()
    .trim()
    .min(1, 'Enter the SMTP server, like smtp.yourprovider.com')
    .max(255)
    .refine((v) => v === '' || HOSTNAME_RE.test(v), 'Enter just the server name, like smtp.gmail.com'),
  smtpPort: z.number().int().min(1, 'Enter a port like 465 or 587').max(65535, 'Enter a port like 465 or 587'),
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().max(255),
  smtpPass: z.string().max(500).optional(),
  clearSmtpPass: z.boolean().optional(),
  smtpFromEmail: optionalEmailSchema.optional(),
});
export type UpdateMailboxInput = z.input<typeof updateMailboxSchema>;

// ---------------------------------------------------------------------------
// Test email
// ---------------------------------------------------------------------------

/**
 * `POST /api/settings/test-email` — `to` defaults to the signed-in booker's email. Only
 * admins may send it anywhere else.
 */
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
  /** How it went out; null for emails logged before this was recorded. */
  via: EmailVia | null;
  /** The booker it was sent for (who sent the request, or booked every spot); null = the company. */
  senderName: string | null;
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
