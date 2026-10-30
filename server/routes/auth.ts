/**
 * Auth API (foundation-owned).
 *
 *   POST /api/auth/login                    booker email + password
 *   POST /api/auth/logout                   booker sign out
 *   GET  /api/auth/me                       { booker, comedian, setupComplete, club }
 *   GET  /api/auth/invite/:token            invite details for /accept-invite
 *   POST /api/auth/accept-invite            set password → booker session
 *   POST /api/auth/password                 signed-in booker changes their password
 *   POST /api/auth/comedian/request-code    always 200 { ok: true } (unless rate limited)
 *   POST /api/auth/comedian/verify-code     → comedian session
 *   POST /api/auth/comedian/logout          comedian sign out
 *   POST /api/auth/magic                    magic-link token → comedian session + redirectTo
 *
 * Password and code sign-in are rate limited per IP, per account/email and IP (the hard lock,
 * so nobody can lock someone else out from their own address) and per account/email across
 * IPs (a looser backstop); see server/lib/rateLimit.ts. 429 `{ code: 'rate_limited', retryAfter }`.
 * Limits apply the same to known and unknown emails, so neither the 429 nor any other answer
 * tells whether an account exists.
 */
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { changePasswordSchema, type ChangePasswordResponse } from '../../shared/api/settings';
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
import { getSessionBooker, getSessionComedian, requireBooker } from '../auth/middleware';
import { hashPassword, timingDummyHash, verifyPassword } from '../auth/password';
import { clientIp } from '../auth/request';
import { deleteOtherSessions, signIn, signOut } from '../auth/sessions';
import { consumeLoginToken } from '../auth/tokens';
import type { AppEnv } from '../context';
import { comedians, users } from '../db/schema';
import { sendEmail } from '../email/mailer';
import { loginCodeEmail } from '../email/templates';
import { httpError, jsonError } from '../lib/http';
import { accountIpKey, rateLimiter, tooManyRequests } from '../lib/rateLimit';
import { getClubInfo, getSettings } from '../lib/settings';
import { validate } from '../lib/validate';

export const authRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Bookers
// ---------------------------------------------------------------------------

authRoutes.post('/auth/login', validate('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const db = c.var.db;
  const limits = rateLimiter(db);
  const ip = clientIp(c);
  const accountIp = accountIpKey(email, ip);
  const wait = limits.retryAfter([
    ['loginFailuresPerIp', ip],
    ['loginFailuresPerAccountIp', accountIp],
    ['loginFailuresPerAccount', email],
  ]);
  if (wait) return tooManyRequests(c, wait, 'Too many sign-in attempts');
  // Count the attempt before the (slow) password check so parallel guesses can't all slip
  // past the limit; a success takes it back.
  const undoIpHit = limits.hit('loginFailuresPerIp', ip);
  const undoAccountHit = limits.hit('loginFailuresPerAccount', email);
  limits.hit('loginFailuresPerAccountIp', accountIp);

  const user = db.select().from(users).where(eq(users.email, email)).get();
  // Unknown emails are checked against a dummy hash so they take as long as a wrong password.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await timingDummyHash()));
  if (!user || !user.passwordHash || !passwordOk) {
    return jsonError(c, 401, 'Wrong email or password', 'invalid_credentials');
  }
  // Clear this IP's lock on the account. Failures from other addresses stay counted: the
  // owner signing in mustn't hand a guesser elsewhere a fresh budget.
  undoIpHit();
  undoAccountHit();
  limits.reset('loginFailuresPerAccountIp', accountIp);
  db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id)).run();
  signIn(c, db, 'booker', user.id);
  return c.json({ booker: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

/**
 * Change your own password. Needs the current one (wrong → 400 `wrong_password`, at most 5
 * tries per 15 minutes). Every other session of this booker is signed out; this browser
 * gets a fresh session.
 */
authRoutes.post('/auth/password', requireBooker, validate('json', changePasswordSchema), async (c) => {
  const db = c.var.db;
  const me = c.var.booker;
  const { current, next } = c.req.valid('json');
  const limits = rateLimiter(db);
  const key = String(me.id);
  const wait = limits.retryAfter([['passwordChangeFailuresPerAccount', key]]);
  if (wait) return tooManyRequests(c, wait, 'Too many wrong passwords');
  const undoHit = limits.hit('passwordChangeFailuresPerAccount', key);

  const user = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, me.id)).get();
  if (!(await verifyPassword(current, user?.passwordHash))) {
    const message = "That isn't your current password";
    throw httpError(400, message, 'wrong_password', { issues: [{ path: 'current', message }] });
  }
  undoHit();
  limits.reset('passwordChangeFailuresPerAccount', key);

  const passwordHash = await hashPassword(next);
  const signedOut = db.transaction((tx) => {
    tx.update(users).set({ passwordHash }).where(eq(users.id, me.id)).run();
    // A new session for this browser, then sign out everywhere else.
    const session = signIn(c, tx, 'booker', me.id);
    return deleteOtherSessions(tx, 'booker', me.id, session.token);
  });
  return c.json({ ok: true, signedOut: Math.max(0, signedOut - 1) } satisfies ChangePasswordResponse);
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

/** Rate-limit key for the club-wide sign-in email budget. */
const ALL = 'all';

authRoutes.post('/auth/comedian/request-code', validate('json', requestCodeSchema), (c) => {
  const { email } = c.req.valid('json');
  const db = c.var.db;
  const limits = rateLimiter(db);
  const ip = clientIp(c);
  // Checked before looking the email up, so a 429 says nothing about the roster.
  const wait = limits.retryAfter([['codeRequestsPerIp', ip]]);
  if (wait) return tooManyRequests(c, wait, 'Too many sign-in code requests');
  limits.hit('codeRequestsPerIp', ip);

  const comedian = db
    .select()
    .from(comedians)
    .where(and(eq(comedians.email, email), eq(comedians.archived, false)))
    .get();

  // Same response, in the same time, whether or not the email is known (no account
  // enumeration): the email is sent in the background. In outbox mode sendEmail logs
  // synchronously, so the code is in email_log before this handler returns.
  // The club-wide email cap is only consulted here, when an email would go out, and past it
  // nothing is sent but the answer is the same 200: a 429 would refuse everyone because of a
  // stranger's flood. Checked before issuing, so the comedian's current code stays live.
  if (comedian && !limits.retryAfter([['codeEmailsGlobal', ALL]])) {
    const issued = issueLoginCode(db, comedian.id);
    if (issued.ok) {
      limits.hit('codeEmailsGlobal', ALL);
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
  const limits = rateLimiter(db);
  const ip = clientIp(c);
  const emailIp = accountIpKey(email, ip);
  // Per email whether or not it's on the roster: known and unknown emails answer alike.
  const wait = limits.retryAfter([
    ['codeFailuresPerIp', ip],
    ['codeFailuresPerEmailIp', emailIp],
    ['codeFailuresPerEmail', email],
  ]);
  if (wait) return tooManyRequests(c, wait, 'Too many wrong codes');
  const undoIpHit = limits.hit('codeFailuresPerIp', ip);
  const undoEmailHit = limits.hit('codeFailuresPerEmail', email);
  limits.hit('codeFailuresPerEmailIp', emailIp);

  const comedian = db
    .select()
    .from(comedians)
    .where(and(eq(comedians.email, email), eq(comedians.archived, false)))
    .get();
  const result = comedian ? verifyLoginCode(db, comedian.id, code) : 'invalid';

  // A code locked after 5 wrong tries answers like any wrong code: a different answer here
  // would only ever happen for real comedians (account enumeration).
  if (result !== 'ok' || !comedian) {
    return jsonError(c, 400, "That code isn't right or has expired", 'invalid_code');
  }
  // Like a booker sign-in: clear this IP's lock, keep failures from elsewhere counted.
  undoIpHit();
  undoEmailHit();
  limits.reset('codeFailuresPerEmailIp', emailIp);
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
