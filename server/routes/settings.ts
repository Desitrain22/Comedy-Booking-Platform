/**
 * F6 Settings API (spec §6 F6). Shapes live in shared/api/settings.ts.
 *
 *   GET  /api/settings                    any booker — never returns the SMTP password
 *   PUT  /api/settings                    any booker — partial update; blank smtpPass keeps it.
 *                                         Email settings + app URL (ADMIN_ONLY_SETTINGS) are admin-only
 *   POST /api/settings/test-email         any booker — sends the test template via sendEmail
 *                                         (non-admins only to their own address)
 *   GET  /api/email-log, /email-log/:id   admin — holds comedians' sign-in codes and links (how
 *                                         dev users read the outbox)
 *   GET/POST /api/users, PATCH/DELETE /api/users/:id, POST /api/users/:id/resend-invite   admin
 *   GET  /api/backup                      admin — VACUUM INTO a temp file, streamed as a download
 */
import { and, count, desc, eq, gte, isNotNull, like, ne, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isValidAvailabilityRange } from '../../shared/availability';
import {
  ADMIN_ONLY_SETTINGS,
  SMTP_CONNECTION_FIELDS,
  emailLogQuerySchema,
  inviteUserSchema,
  resendInviteSchema,
  testEmailSchema,
  updateSettingsSchema,
  updateUserSchema,
  type AdminOnlySetting,
  type BookerUserDto,
  type BookerUserStatus,
  type EmailLogDetail,
  type EmailLogItem,
  type InviteResponse,
  type SettingsDto,
  type TestEmailResponse,
} from '../../shared/api/settings';
import { emailSchema } from '../../shared/schemas';
import { weekStartOf } from '../../shared/time';
import type { OkResponse } from '../../shared/types';
import { createInvite, regenerateInvite, sendBookerInvite, type InviteResult } from '../auth/invites';
import { requireAdmin, requireBooker } from '../auth/middleware';
import { deleteSessionsFor } from '../auth/sessions';
import type { AppEnv } from '../context';
import type { DbOrTx } from '../db/client';
import { emailLog, jobRuns, users, type EmailLogEntry, type User } from '../db/schema';
import { getMailConfig, sendEmail, type SendEmailResult } from '../email/mailer';
import { testEmail } from '../email/templates';
import { httpError, orNotFound, parseId } from '../lib/http';
import { clubToday, getAppUrl, getSettings, updateSettings, type Settings, type SettingsUpdate } from '../lib/settings';
import { validate } from '../lib/validate';
import { confirmationsJobKey } from '../services/scheduler';

export const settingsRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Settings as the API exposes them. Built field by field so the SMTP password can't leak. */
export function toSettingsDto(db: DbOrTx): SettingsDto {
  const s = getSettings(db);
  const mail = getMailConfig(db);
  const last = db
    .select({ id: emailLog.id, status: emailLog.status, error: emailLog.error, createdAt: emailLog.createdAt })
    .from(emailLog)
    .where(ne(emailLog.status, 'outbox'))
    .orderBy(desc(emailLog.id))
    .limit(1)
    .get();
  // Weeks from this one on whose automatic send already ran (job_runs `confirmations:<Monday>`).
  const thisWeek = confirmationsJobKey(weekStartOf(clubToday(db)));
  const confirmationWeeksSent = db
    .select({ key: jobRuns.key })
    .from(jobRuns)
    .where(and(like(jobRuns.key, 'confirmations:%'), gte(jobRuns.key, thisWeek)))
    .all()
    .map((r) => r.key.slice('confirmations:'.length));
  return {
    clubName: s.clubName,
    timezone: s.timezone,
    appUrl: s.appUrl,
    effectiveAppUrl: getAppUrl(db),
    allNightStartMin: s.allNightStartMin,
    allNightEndMin: s.allNightEndMin,
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    smtpSecure: s.smtpSecure,
    smtpUser: s.smtpUser,
    smtpPassSet: s.smtpPass !== '',
    fromName: s.fromName,
    fromEmail: s.fromEmail,
    replyTo: s.replyTo,
    emailConfigured: mail !== null,
    emailSource: mail?.source ?? null,
    emailHost: mail?.host ?? null,
    emailFrom: mail?.from || null,
    lastEmail: last && last.status !== 'outbox' ? { ...last, status: last.status } : null,
    confirmationsEnabled: s.confirmationsEnabled,
    confirmationDay: s.confirmationDay,
    confirmationTimeMin: s.confirmationTimeMin,
    catchUpEnabled: s.catchUpEnabled,
    allowDeclines: s.allowDeclines,
    confirmationWeeksSent,
  };
}

function invalid(path: string, message: string, code = 'validation_error') {
  return httpError(400, message, code, { issues: [{ path, message }] });
}

const SMTP_FIELDS = ['smtpHost', 'smtpUser', 'fromEmail'] as const;

settingsRoutes.get('/settings', requireBooker, (c) => c.json(toSettingsDto(c.var.db)));

/**
 * The admin-only fields this (validated) body would change. Unchanged values are fine, so a
 * booker's form may send them back as they are.
 */
export function adminOnlyChanges(
  input: Partial<Record<AdminOnlySetting, unknown>>,
  current: Settings,
): AdminOnlySetting[] {
  return ADMIN_ONLY_SETTINGS.filter((field) => {
    const value = input[field];
    if (value === undefined) return false;
    if (field === 'smtpPass') return typeof value === 'string' && value.trim() !== '';
    if (field === 'clearSmtpPass') return value === true && current.smtpPass !== '';
    return value !== current[field];
  });
}

settingsRoutes.put('/settings', requireBooker, validate('json', updateSettingsSchema), (c) => {
  const db = c.var.db;
  const input = c.req.valid('json');
  const { smtpPass, clearSmtpPass, ...fields } = input;
  const current = getSettings(db);

  // Email settings decide where sign-in links, codes and confirmations go (and hold the SMTP
  // password); the app URL starts every emailed link. Only admins may redirect them.
  if (c.var.booker.role !== 'admin') {
    const blocked = adminOnlyChanges(input, current);
    if (blocked.length > 0) {
      throw httpError(403, 'Only admins can change email settings and the app address', 'admin_only', {
        fields: blocked,
      });
    }
  }

  const patch: SettingsUpdate = { ...fields };
  if (clearSmtpPass) patch.smtpPass = '';
  else if (smtpPass !== undefined && smtpPass.trim() !== '') patch.smtpPass = smtpPass;
  // A saved password is only ever sent to the server it was entered for: pointing the
  // connection somewhere else without typing it again removes it.
  if (
    patch.smtpPass === undefined &&
    current.smtpPass !== '' &&
    SMTP_CONNECTION_FIELDS.some((f) => patch[f] !== undefined && patch[f] !== current[f])
  ) {
    patch.smtpPass = '';
  }

  // Cross-field checks run against the merged result (the body may hold only one side).
  const merged = { ...current, ...patch };
  if (
    (patch.allNightStartMin !== undefined || patch.allNightEndMin !== undefined) &&
    !isValidAvailabilityRange({ startMin: merged.allNightStartMin, endMin: merged.allNightEndMin })
  ) {
    throw invalid('allNightEndMin', 'All night must end after it starts (between 4 PM and 2 AM)');
  }
  if (
    merged.smtpHost !== '' &&
    SMTP_FIELDS.some((f) => patch[f] !== undefined) &&
    !emailSchema.safeParse(merged.fromEmail || merged.smtpUser).success
  ) {
    throw invalid(
      'fromEmail',
      "Enter the From email address — your SMTP username isn't an email address",
      'from_email_required',
    );
  }

  if (Object.keys(patch).length > 0) updateSettings(db, patch);
  return c.json(toSettingsDto(db));
});

// ---------------------------------------------------------------------------
// Test email
// ---------------------------------------------------------------------------

/**
 * How long the test-email request waits for the SMTP server before giving up. A backstop:
 * the transport's own timeouts (`SMTP_TIMEOUTS`, 10s connect + 10s greeting, 20s idle)
 * normally fail first with a more specific error, which gets a hint like any other failure.
 */
export const TEST_EMAIL_TIMEOUT_MS = 25_000;

/** A plain-language next step for a raw SMTP error message. */
export function smtpErrorHint(error: string, server: { host: string; port: number }): string {
  const host = server.host.toLowerCase();
  const where = `${server.host}:${server.port}`;
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

settingsRoutes.post('/settings/test-email', requireBooker, validate('json', testEmailSchema), async (c) => {
  const db = c.var.db;
  const me = c.var.booker;
  const to = c.req.valid('json').to ?? me.email;
  // Bookers test with their own inbox; only admins may send it elsewhere.
  if (to !== me.email && me.role !== 'admin') {
    throw httpError(403, 'You can only send the test email to yourself', 'forbidden');
  }
  const config = getMailConfig(db);
  const content = testEmail({ clubName: getSettings(db).clubName, name: to === me.email ? me.name : undefined });

  const sending = sendEmail(db, { to, kind: 'test', ...content });
  // A late result still lands in the email log; don't let it surface as an unhandled rejection.
  sending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), TEST_EMAIL_TIMEOUT_MS);
  });
  const result: SendEmailResult | 'timeout' = await Promise.race([sending, timeout]).finally(() => clearTimeout(timer));

  if (result === 'timeout') {
    const where = config ? `${config.host}:${config.port}` : 'the mail server';
    throw httpError(504, `No answer from ${where} after ${TEST_EMAIL_TIMEOUT_MS / 1000} seconds`, 'email_timeout', {
      hint: config
        ? smtpErrorHint('ETIMEDOUT', config)
        : 'Check the host and port with your email provider.',
    });
  }
  if (result.status === 'failed') {
    const smtpError = result.error ?? 'Unknown error';
    throw httpError(502, `Couldn't send the test email: ${smtpError}`, 'email_failed', {
      smtpError,
      hint: config ? smtpErrorHint(smtpError, config) : undefined,
      logId: result.id,
    });
  }
  return c.json({ status: result.status, to, logId: result.id } satisfies TestEmailResponse);
});

// ---------------------------------------------------------------------------
// Email log
// ---------------------------------------------------------------------------

function toEmailLogItem(row: EmailLogEntry): EmailLogItem {
  return {
    id: row.id,
    toEmail: row.toEmail,
    subject: row.subject,
    kind: row.kind,
    status: row.status,
    error: row.error,
    comedianId: row.comedianId,
    createdAt: row.createdAt,
  };
}

/** Escape LIKE wildcards so a search for "50%" means the literal text. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// Admin only: the log holds comedians' sign-in codes and magic links.
settingsRoutes.get('/email-log', requireAdmin, validate('query', emailLogQuerySchema), (c) => {
  const { q, kind, status, limit } = c.req.valid('query');
  const conditions: (SQL | undefined)[] = [];
  if (q) {
    const pattern = likePattern(q);
    conditions.push(or(like(emailLog.toEmail, pattern), like(emailLog.subject, pattern)));
  }
  if (kind) conditions.push(eq(emailLog.kind, kind));
  if (status) conditions.push(eq(emailLog.status, status));
  const rows = c.var.db
    .select()
    .from(emailLog)
    .where(and(...conditions))
    .orderBy(desc(emailLog.id))
    .limit(limit)
    .all();
  return c.json(rows.map(toEmailLogItem));
});

settingsRoutes.get('/email-log/:id', requireAdmin, (c) => {
  const id = parseId(c.req.param('id'));
  const row = orNotFound(c.var.db.select().from(emailLog).where(eq(emailLog.id, id)).get(), 'Email');
  return c.json({ ...toEmailLogItem(row), bodyHtml: row.bodyHtml, bodyText: row.bodyText } satisfies EmailLogDetail);
});

// ---------------------------------------------------------------------------
// Bookers (admin only)
// ---------------------------------------------------------------------------

function userStatus(user: User, now = Date.now()): BookerUserStatus {
  if (user.passwordHash) return 'active';
  return user.inviteExpiresAt != null && user.inviteExpiresAt > now ? 'invited' : 'invite_expired';
}

function toUserDto(user: User): BookerUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: userStatus(user),
    inviteExpiresAt: user.passwordHash ? null : user.inviteExpiresAt,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

/** Admins who can actually sign in (have a password), other than `exceptId`. */
function otherActiveAdminCount(db: DbOrTx, exceptId: number): number {
  return (
    db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNotNull(users.passwordHash), ne(users.id, exceptId)))
      .get()?.n ?? 0
  );
}

function isActiveAdmin(user: User): boolean {
  return user.role === 'admin' && user.passwordHash != null;
}

async function inviteResponse(
  db: DbOrTx,
  invite: InviteResult,
  inviterName: string,
  send: boolean,
): Promise<InviteResponse> {
  let email: InviteResponse['email'] = { status: 'skipped' };
  if (send) {
    const result = await sendBookerInvite(db, { user: invite.user, inviteUrl: invite.inviteUrl, inviterName });
    email = result.error ? { status: result.status, error: result.error } : { status: result.status };
  }
  return { user: toUserDto(invite.user), inviteUrl: invite.inviteUrl, email };
}

function findUser(db: DbOrTx, id: number): User {
  return orNotFound(db.select().from(users).where(eq(users.id, id)).get(), 'Booker');
}

settingsRoutes.get('/users', requireAdmin, (c) => {
  const rows = c.var.db.select().from(users).orderBy(users.createdAt, users.id).all();
  return c.json(rows.map(toUserDto));
});

settingsRoutes.post('/users', requireAdmin, validate('json', inviteUserSchema), async (c) => {
  const db = c.var.db;
  const { sendEmail: send, ...input } = c.req.valid('json');
  const invite = createInvite(db, input);
  return c.json(await inviteResponse(db, invite, c.var.booker.name, send), 201);
});

settingsRoutes.patch('/users/:id', requireAdmin, validate('json', updateUserSchema), (c) => {
  const db = c.var.db;
  const target = findUser(db, parseId(c.req.param('id')));
  const patch = c.req.valid('json');
  if (Object.keys(patch).length === 0) throw httpError(400, 'Nothing to update', 'validation_error');
  if (patch.role === 'booker' && isActiveAdmin(target) && otherActiveAdminCount(db, target.id) === 0) {
    throw httpError(409, 'The club needs at least one admin. Make someone else an admin first.', 'last_admin');
  }
  const updated = db.update(users).set(patch).where(eq(users.id, target.id)).returning().get();
  return c.json(toUserDto(updated));
});

settingsRoutes.delete('/users/:id', requireAdmin, (c) => {
  const db = c.var.db;
  const target = findUser(db, parseId(c.req.param('id')));
  if (target.id === c.var.booker.id) {
    throw httpError(409, "You can't remove yourself. Ask another admin to do it.", 'cannot_remove_self');
  }
  if (isActiveAdmin(target) && otherActiveAdminCount(db, target.id) === 0) {
    throw httpError(409, "You can't remove the last admin.", 'last_admin');
  }
  db.transaction((tx) => {
    deleteSessionsFor(tx, 'booker', target.id);
    tx.delete(users).where(eq(users.id, target.id)).run();
  });
  return c.json({ ok: true } satisfies OkResponse);
});

settingsRoutes.post('/users/:id/resend-invite', requireAdmin, validate('json', resendInviteSchema), async (c) => {
  const db = c.var.db;
  const invite = regenerateInvite(db, parseId(c.req.param('id')));
  return c.json(await inviteResponse(db, invite, c.var.booker.name, c.req.valid('json').sendEmail));
});

// ---------------------------------------------------------------------------
// Backup (admin only)
// ---------------------------------------------------------------------------

/** Safety net: remove a backup temp file even if the download is never read. */
const BACKUP_TEMP_TTL_MS = 10 * 60_000;

settingsRoutes.get('/backup', requireAdmin, async (c) => {
  const db = c.var.db;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cbp-backup-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    void rm(dir, { recursive: true, force: true });
  };

  const file = path.join(dir, 'club.db');
  let size: number;
  try {
    // A consistent, compacted snapshot of the live (WAL) database in one file.
    db.$client.prepare('VACUUM INTO ?').run(file);
    size = (await stat(file)).size;
  } catch (err) {
    cleanup();
    throw err;
  }

  const stream = createReadStream(file);
  stream.once('close', cleanup);
  setTimeout(cleanup, BACKUP_TEMP_TTL_MS).unref();

  const filename = `club-backup-${clubToday(db)}.db`;
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    headers: {
      'content-type': 'application/vnd.sqlite3',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
});
