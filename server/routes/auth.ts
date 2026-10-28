/**
 * Auth API (foundation-owned).
 *
 *   POST /api/auth/login                    booker email + password
 *   POST /api/auth/logout                   booker sign out
 *   GET  /api/auth/me                       { booker, comedian, setupComplete, club }
 *   GET  /api/auth/invite/:token            invite details for /accept-invite
 *   POST /api/auth/accept-invite            set password → booker session
 *   POST /api/auth/comedian/request-code    always 200 { ok: true }
 *   POST /api/auth/comedian/verify-code     → comedian session
 *   POST /api/auth/comedian/logout          comedian sign out
 *   POST /api/auth/magic                    magic-link token → comedian session + redirectTo
 */
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  acceptInviteSchema,
  loginSchema,
  magicLinkSchema,
  requestCodeSchema,
  verifyCodeSchema,
} from '../../shared/schemas';
import type { InviteInfo, MagicLinkResponse, MeResponse } from '../../shared/types';
import { issueLoginCode, verifyLoginCode } from '../auth/codes';
import { acceptInvite, findInvite } from '../auth/invites';
import { getSessionBooker, getSessionComedian } from '../auth/middleware';
import { verifyPassword } from '../auth/password';
import { signIn, signOut } from '../auth/sessions';
import { consumeLoginToken } from '../auth/tokens';
import type { AppEnv } from '../context';
import { comedians, users } from '../db/schema';
import { sendEmail } from '../email/mailer';
import { loginCodeEmail } from '../email/templates';
import { jsonError } from '../lib/http';
import { getClubInfo, getSettings } from '../lib/settings';
import { validate } from '../lib/validate';

export const authRoutes = new Hono<AppEnv>();

/**
 * A bcrypt hash of a random throwaway password. Unknown emails are still checked against
 * it so a login attempt takes the same time whether or not the account exists.
 */
const TIMING_DUMMY_HASH = '$2b$10$n0mZOg73N.y9z6mPRof6b.HWFgQAX.hGon2oLoEbuUPEjMKCSNLFC';

// ---------------------------------------------------------------------------
// Bookers
// ---------------------------------------------------------------------------

authRoutes.post('/auth/login', validate('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const db = c.var.db;
  const user = db.select().from(users).where(eq(users.email, email)).get();
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? TIMING_DUMMY_HASH);
  if (!user || !user.passwordHash || !passwordOk) {
    return jsonError(c, 401, 'Wrong email or password', 'invalid_credentials');
  }
  db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id)).run();
  signIn(c, db, 'booker', user.id);
  return c.json({ booker: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

authRoutes.post('/auth/logout', (c) => {
  signOut(c, c.var.db, 'booker');
  return c.json({ ok: true as const });
});

authRoutes.get('/auth/me', (c) => {
  const db = c.var.db;
  const body: MeResponse = {
    booker: getSessionBooker(c),
    comedian: getSessionComedian(c),
    setupComplete: getSettings(db).setupComplete,
    club: getClubInfo(db),
  };
  return c.json(body);
});

authRoutes.get('/auth/invite/:token', (c) => {
  const db = c.var.db;
  const user = findInvite(db, c.req.param('token'));
  if (!user) return jsonError(c, 404, 'This invite link is invalid or has expired', 'invalid_invite');
  const body: InviteInfo = { email: user.email, name: user.name, clubName: getSettings(db).clubName };
  return c.json(body);
});

authRoutes.post('/auth/accept-invite', validate('json', acceptInviteSchema), async (c) => {
  const db = c.var.db;
  const user = await acceptInvite(db, c.req.valid('json'));
  signIn(c, db, 'booker', user.id);
  return c.json({ booker: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ---------------------------------------------------------------------------
// Comedians
// ---------------------------------------------------------------------------

authRoutes.post('/auth/comedian/request-code', validate('json', requestCodeSchema), (c) => {
  const { email } = c.req.valid('json');
  const db = c.var.db;
  const comedian = db
    .select()
    .from(comedians)
    .where(and(eq(comedians.email, email), eq(comedians.archived, false)))
    .get();

  // Same response, in the same time, whether or not the email is known (no account
  // enumeration): the email is sent in the background. In outbox mode sendEmail logs
  // synchronously, so the code is in email_log before this handler returns.
  if (comedian) {
    const issued = issueLoginCode(db, comedian.id);
    if (issued.ok) {
      const content = loginCodeEmail({ clubName: getSettings(db).clubName, name: comedian.name, code: issued.code });
      sendEmail(db, { to: comedian.email, kind: 'login_code', comedianId: comedian.id, ...content }).catch(
        (err: unknown) => console.error('[auth] failed to record login code email', err),
      );
    }
  }
  return c.json({ ok: true as const });
});

authRoutes.post('/auth/comedian/verify-code', validate('json', verifyCodeSchema), (c) => {
  const { email, code } = c.req.valid('json');
  const db = c.var.db;
  const comedian = db
    .select()
    .from(comedians)
    .where(and(eq(comedians.email, email), eq(comedians.archived, false)))
    .get();
  const result = comedian ? verifyLoginCode(db, comedian.id, code) : 'invalid';

  if (result === 'too_many_attempts') {
    return jsonError(c, 429, 'Too many wrong tries. Ask for a new code.', 'too_many_attempts');
  }
  if (result !== 'ok' || !comedian) {
    return jsonError(c, 400, "That code isn't right or has expired", 'invalid_code');
  }
  db.update(comedians).set({ lastLoginAt: Date.now() }).where(eq(comedians.id, comedian.id)).run();
  signIn(c, db, 'comedian', comedian.id);
  return c.json({ comedian: { id: comedian.id, email: comedian.email, name: comedian.name } });
});

authRoutes.post('/auth/comedian/logout', (c) => {
  signOut(c, c.var.db, 'comedian');
  return c.json({ ok: true as const });
});

authRoutes.post('/auth/magic', validate('json', magicLinkSchema), (c) => {
  const db = c.var.db;
  const found = consumeLoginToken(db, c.req.valid('json').token);
  const comedian = found
    ? db
        .select()
        .from(comedians)
        .where(and(eq(comedians.id, found.comedianId), eq(comedians.archived, false)))
        .get()
    : undefined;
  if (!found || !comedian) {
    return jsonError(c, 400, 'This sign-in link is invalid or has expired', 'invalid_token');
  }
  db.update(comedians).set({ lastLoginAt: Date.now() }).where(eq(comedians.id, comedian.id)).run();
  signIn(c, db, 'comedian', comedian.id);
  const body: MagicLinkResponse = {
    redirectTo: found.redirectTo,
    comedian: { id: comedian.id, email: comedian.email, name: comedian.name },
  };
  return c.json(body);
});
