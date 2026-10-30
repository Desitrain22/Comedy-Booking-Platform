/**
 * Each booker's own mailbox (hosted MVP spec §5; Settings → Account → Your mailbox). With
 * senderMode `booker`, emails sent as a booker go out through their mailbox when they've
 * connected one. Every signed-in booker manages only their own: there is no route to read
 * or change anyone else's, admins included, and the password never leaves the server.
 * Shapes live in shared/api/settings.ts.
 *
 *   GET    /api/me/mailbox        MailboxDto
 *   PUT    /api/me/mailbox        UpdateMailboxInput → MailboxDto (blank smtpPass keeps the saved
 *                                 one unless the server, port, security or username changed)
 *                                 | 400 from_email_required | 400 smtp_host_not_allowed (hosted mode:
 *                                 a local, internal or private-network server)
 *   DELETE /api/me/mailbox        → MailboxDto (disconnected)
 *   POST   /api/me/mailbox/test   → TestEmailResponse: the test email, to yourself, through your
 *                                 mailbox | 409 mailbox_not_connected | 502 email_failed | 504 email_timeout
 *
 * Mounted under /api by server/routes/settings.ts.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  updateMailboxSchema,
  type MailboxDto,
  type TestEmailResponse,
} from '../../shared/api/settings';
import { emailSchema } from '../../shared/schemas';
import { requireBooker } from '../auth/middleware';
import type { AppEnv } from '../context';
import type { DbOrTx } from '../db/client';
import { emailLog, users, type User } from '../db/schema';
import { bookerMailbox, previewSender, sendEmail } from '../email/mailer';
import { testEmail } from '../email/templates';
import { SMTP_HOST_NOT_ALLOWED_MESSAGE, smtpHostNotAllowed } from '../email/smtpHostGuard';
import { awaitTestEmail } from '../email/testEmail';
import { env } from '../env';
import { httpError, orNotFound } from '../lib/http';
import { encryptSecret } from '../lib/secrets';
import { getSettings } from '../lib/settings';
import { validate } from '../lib/validate';

export const mailboxRoutes = new Hono<AppEnv>();

/** The mailbox fields a booker row holds. */
type MailboxFields = Pick<User, 'smtpHost' | 'smtpPort' | 'smtpSecure' | 'smtpUser' | 'smtpPass' | 'smtpFromEmail'>;

const DISCONNECTED: MailboxFields = {
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPass: '',
  smtpFromEmail: '',
};

/** Changing any of these without typing the password again removes the saved one. */
const CONNECTION_FIELDS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser'] as const;

function loadUser(db: DbOrTx, id: number): User {
  return orNotFound(db.select().from(users).where(eq(users.id, id)).get(), 'Booker');
}

/** A booker's mailbox as the API shows it to them. Built field by field so the password can't leak. */
export function toMailboxDto(db: DbOrTx, userId: number): MailboxDto {
  const user = loadUser(db, userId);
  const last = db
    .select({ id: emailLog.id, status: emailLog.status, error: emailLog.error, createdAt: emailLog.createdAt })
    .from(emailLog)
    .where(and(eq(emailLog.via, 'booker-mailbox'), eq(emailLog.senderUserId, userId), ne(emailLog.status, 'outbox')))
    .orderBy(desc(emailLog.id))
    .limit(1)
    .get();
  return {
    connected: user.smtpHost !== '',
    smtpHost: user.smtpHost,
    smtpPort: user.smtpPort,
    smtpSecure: user.smtpSecure,
    smtpUser: user.smtpUser,
    smtpPassSet: user.smtpPass !== '',
    smtpFromEmail: user.smtpFromEmail,
    senderMode: getSettings(db).senderMode,
    preview: previewSender(db, { senderUserId: userId, senderMode: 'booker' }),
    lastEmail: last && last.status !== 'outbox' ? { ...last, status: last.status } : null,
  };
}

mailboxRoutes.get('/me/mailbox', requireBooker, (c) => c.json(toMailboxDto(c.var.db, c.var.booker.id)));

mailboxRoutes.put('/me/mailbox', requireBooker, validate('json', updateMailboxSchema), (c) => {
  const db = c.var.db;
  const me = c.var.booker.id;
  const input = c.req.valid('json');
  const current = loadUser(db, me);

  const next: MailboxFields = {
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUser: input.smtpUser,
    smtpFromEmail: input.smtpFromEmail ?? current.smtpFromEmail,
    smtpPass: current.smtpPass,
  };
  if (input.clearSmtpPass) next.smtpPass = '';
  else if (input.smtpPass !== undefined && input.smtpPass.trim() !== '') next.smtpPass = encryptSecret(input.smtpPass);
  // A saved password only ever goes to the server it was entered for.
  else if (CONNECTION_FIELDS.some((f) => next[f] !== current[f])) next.smtpPass = '';

  // Hosted mode: a public server only, never one inside our network.
  if (env.hosted && smtpHostNotAllowed(next.smtpHost)) {
    throw httpError(400, SMTP_HOST_NOT_ALLOWED_MESSAGE, 'smtp_host_not_allowed', {
      issues: [{ path: 'smtpHost', message: SMTP_HOST_NOT_ALLOWED_MESSAGE }],
    });
  }
  if (!emailSchema.safeParse(next.smtpFromEmail || next.smtpUser).success) {
    throw httpError(
      400,
      "Enter the From email address — your SMTP username isn't an email address",
      'from_email_required',
      { issues: [{ path: 'smtpFromEmail', message: 'Enter the email address messages come from' }] },
    );
  }

  db.update(users).set(next).where(eq(users.id, me)).run();
  return c.json(toMailboxDto(db, me));
});

mailboxRoutes.delete('/me/mailbox', requireBooker, (c) => {
  const db = c.var.db;
  db.update(users).set(DISCONNECTED).where(eq(users.id, c.var.booker.id)).run();
  return c.json(toMailboxDto(db, c.var.booker.id));
});

mailboxRoutes.post('/me/mailbox/test', requireBooker, async (c) => {
  const db = c.var.db;
  const me = c.var.booker;
  const mailbox = bookerMailbox(loadUser(db, me.id));
  if (!mailbox) throw httpError(409, 'Connect your mailbox first', 'mailbox_not_connected');
  const content = testEmail({ clubName: getSettings(db).clubName, name: me.name, mailbox: 'booker' });
  // Through this booker's mailbox whatever the club's senderMode: that's what's being tested.
  const sending = sendEmail(db, { to: me.email, kind: 'test', ...content, senderUserId: me.id, senderMode: 'booker' });
  const result = await awaitTestEmail(sending, mailbox);
  return c.json({ status: result.status, to: me.email, logId: result.id } satisfies TestEmailResponse);
});
