/**
 * Owner-console sign-in (hosted MVP spec §6): one-time 6-digit codes by email, then a session
 * cookie on the platform host. Only addresses in PLATFORM_ADMIN_EMAILS (`platform.hosted
 * .adminEmails`) ever get a code, and a session only counts while its address is still listed.
 *
 *   const issued = issueAdminCode(platform.db, email);        // { code } (older live codes die)
 *   verifyAdminCode(platform.db, email, '123456');            // 'ok' | 'invalid' | 'too_many_attempts'
 *   startAdminSession(c, platform, email);                    // row in admin_sessions + cookie
 *   router.get('/platform/admin/overview', requirePlatformAdmin(platform), (c) => c.var.platformAdmin.email);
 *
 * Codes: 10 minutes, 5 wrong tries, stored hashed; asking again retires the older ones.
 * Sessions: 7 days, stored as the sha256 of the cookie's token. The cookie is
 * `__Host-cbp_platform` (Secure, this host only) over https and `cbp_platform` over plain http,
 * HttpOnly and SameSite=Strict: the console is a single-page app, so its own API calls always
 * carry it, and no other site can make the browser send it.
 *
 * Not to be confused with the club's `requireAdmin` (server/auth/middleware.ts: a club booker
 * with the admin role).
 */
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { randomDigits, randomToken, safeEqualHex, sha256Hex } from '../auth/crypto';
import { isHttpsRequest } from '../auth/request';
import type { AppVariables } from '../context';
import {
  emailFinePrint,
  emailParagraph,
  escapeHtml,
  renderEmailLayout,
  type EmailContent,
} from '../email/templates';
import type { HostedEnv } from '../env';
import { jsonError } from '../lib/http';
import type { PlatformDb } from './db';
import type { Platform } from './index';
import { adminLoginCodes, adminSessions } from './schema';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const ADMIN_CODE_LENGTH = 6;
export const ADMIN_CODE_TTL_MS = 10 * MINUTE;
export const ADMIN_CODE_MAX_ATTEMPTS = 5;
export const ADMIN_SESSION_TTL_MS = 7 * DAY;

/** The cookie's name over plain http; over https it is `__Host-cbp_platform`. */
export const PLATFORM_ADMIN_COOKIE = 'cbp_platform';

/** The signed-in owner, as put on `c.var.platformAdmin` by requirePlatformAdmin. */
export interface PlatformAdmin {
  email: string;
}

export interface PlatformAdminEnv {
  Variables: AppVariables & { platformAdmin: PlatformAdmin };
}

/** Is this address allowed into the owner console right now? */
export function isPlatformAdminEmail(hosted: Pick<HostedEnv, 'adminEmails'>, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized !== '' && hosted.adminEmails.some((listed) => listed.trim().toLowerCase() === normalized);
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

function hashAdminCode(email: string, code: string): string {
  return sha256Hex(`platform-admin:${email}:${code}`);
}

/** A new code for `email` (the caller checks it is an owner's). Older live codes stop working. */
export function issueAdminCode(db: PlatformDb, email: string, now = Date.now()): { code: string; expiresAt: number } {
  const code = randomDigits(ADMIN_CODE_LENGTH);
  const expiresAt = now + ADMIN_CODE_TTL_MS;
  db.transaction((tx) => {
    tx.update(adminLoginCodes)
      .set({ expiresAt: now })
      .where(and(eq(adminLoginCodes.email, email), isNull(adminLoginCodes.usedAt), gt(adminLoginCodes.expiresAt, now)))
      .run();
    tx.insert(adminLoginCodes).values({ email, codeHash: hashAdminCode(email, code), expiresAt, createdAt: now }).run();
  });
  return { code, expiresAt };
}

export type AdminCodeResult = 'ok' | 'invalid' | 'too_many_attempts';

/**
 * Check a code against the address's live (unexpired, unused) code. A wrong guess counts
 * against it; after 5 the code is dead. A right one is used up.
 */
export function verifyAdminCode(db: PlatformDb, email: string, code: string, now = Date.now()): AdminCodeResult {
  return db.transaction((tx) => {
    const live = tx
      .select()
      .from(adminLoginCodes)
      .where(and(eq(adminLoginCodes.email, email), isNull(adminLoginCodes.usedAt), gt(adminLoginCodes.expiresAt, now)))
      .orderBy(desc(adminLoginCodes.createdAt), desc(adminLoginCodes.id))
      .all();
    if (!live.length) return 'invalid';
    const usable = live.filter((row) => row.attempts < ADMIN_CODE_MAX_ATTEMPTS);
    if (!usable.length) return 'too_many_attempts';

    const hash = hashAdminCode(email, code);
    const match = usable.find((row) => safeEqualHex(row.codeHash, hash));
    if (match) {
      tx.update(adminLoginCodes)
        .set({ usedAt: now })
        .where(and(eq(adminLoginCodes.email, email), isNull(adminLoginCodes.usedAt)))
        .run();
      return 'ok';
    }
    for (const row of usable) {
      tx.update(adminLoginCodes).set({ attempts: row.attempts + 1 }).where(eq(adminLoginCodes.id, row.id)).run();
    }
    return usable.every((row) => row.attempts + 1 >= ADMIN_CODE_MAX_ATTEMPTS) ? 'too_many_attempts' : 'invalid';
  });
}

/** The sign-in code email. */
export function adminLoginCodeEmail(p: { platformName: string; code: string; consoleUrl: string }): EmailContent {
  const subject = `${p.code} is your ${p.platformName} owner console code`;
  const html = renderEmailLayout({
    clubName: p.platformName,
    preheader: `Your owner console code is ${p.code}. It expires in 10 minutes.`,
    heading: 'Owner console sign-in',
    bodyHtml: [
      emailParagraph('Here is your code to sign in to the owner console:'),
      `<div style="margin:20px 0;font-size:32px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(p.code)}</div>`,
      emailParagraph('It expires in 10 minutes.'),
      emailFinePrint(
        `If you didn't try to sign in to <a href="${escapeHtml(p.consoleUrl)}">${escapeHtml(p.consoleUrl)}</a>, you can ignore this email.`,
      ),
    ].join('\n'),
    footerHtml: `Sent by ${escapeHtml(p.platformName)}`,
  });
  const text = [
    `Your ${p.platformName} owner console code is: ${p.code}`,
    '',
    `It expires in 10 minutes. If you didn't try to sign in to ${p.consoleUrl}, you can ignore this email.`,
  ].join('\n');
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createAdminSession(db: PlatformDb, email: string, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomToken();
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  db.insert(adminSessions).values({ id: sha256Hex(token), email, expiresAt, createdAt: now }).run();
  return { token, expiresAt };
}

/**
 * The owner signed in with this token, or null: unknown, expired, or their address is no
 * longer in PLATFORM_ADMIN_EMAILS (that session is then deleted for good).
 */
export function findAdminSession(platform: Platform, token: string, now = Date.now()): PlatformAdmin | null {
  const id = sha256Hex(token);
  const row = platform.db.select().from(adminSessions).where(eq(adminSessions.id, id)).get();
  if (!row) return null;
  if (row.expiresAt <= now || !isPlatformAdminEmail(platform.hosted, row.email)) {
    platform.db.delete(adminSessions).where(eq(adminSessions.id, id)).run();
    return null;
  }
  return { email: row.email };
}

export function deleteAdminSession(db: PlatformDb, token: string): void {
  db.delete(adminSessions).where(eq(adminSessions.id, sha256Hex(token))).run();
}

/** Housekeeping on each sign-in: expired sessions, and codes dead for over a day. */
export function deleteStaleAdminAuth(db: PlatformDb, now = Date.now()): void {
  db.delete(adminSessions).where(lt(adminSessions.expiresAt, now)).run();
  db.delete(adminLoginCodes)
    .where(or(lt(adminLoginCodes.expiresAt, now - DAY), lt(adminLoginCodes.usedAt, now - DAY)))
    .run();
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/** Secure (`__Host-`) cookie when the platform is https, or this request came in over https. */
function wantsSecureCookie(c: Context, hosted: Pick<HostedEnv, 'protocol'>): boolean {
  return hosted.protocol === 'https:' || isHttpsRequest(c);
}

/** The session token from this request. Over https only the `__Host-` cookie counts. */
export function readAdminToken(c: Context, hosted: Pick<HostedEnv, 'protocol'>): string | undefined {
  const value = wantsSecureCookie(c, hosted)
    ? getCookie(c, PLATFORM_ADMIN_COOKIE, 'host')
    : getCookie(c, PLATFORM_ADMIN_COOKIE);
  return value || undefined;
}

function setAdminCookie(
  c: Context,
  hosted: Pick<HostedEnv, 'protocol'>,
  session: { token: string; expiresAt: number },
  now: number,
): void {
  const { token, expiresAt } = session;
  const options = {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    expires: new Date(expiresAt),
    maxAge: Math.round((expiresAt - now) / 1000),
  } as const;
  if (wantsSecureCookie(c, hosted)) {
    setCookie(c, PLATFORM_ADMIN_COOKIE, token, { ...options, secure: true, prefix: 'host' });
  } else {
    setCookie(c, PLATFORM_ADMIN_COOKIE, token, { ...options, secure: false });
  }
}

/** Clear both spellings of the cookie (whichever this browser has). */
function clearAdminCookie(c: Context): void {
  deleteCookie(c, PLATFORM_ADMIN_COOKIE, { path: '/' });
  if (getCookie(c, PLATFORM_ADMIN_COOKIE, 'host') !== undefined) {
    deleteCookie(c, PLATFORM_ADMIN_COOKIE, { path: '/', secure: true, prefix: 'host' });
  }
}

/** Sign `email` in: a new session and its cookie on the response. */
export function startAdminSession(c: Context, platform: Platform, email: string): PlatformAdmin {
  const now = Date.now();
  deleteStaleAdminAuth(platform.db, now);
  setAdminCookie(c, platform.hosted, createAdminSession(platform.db, email, now), now);
  return { email };
}

/** The signed-in owner for this request, or null. */
export function getPlatformAdmin(c: Context, platform: Platform): PlatformAdmin | null {
  const token = readAdminToken(c, platform.hosted);
  return token ? findAdminSession(platform, token) : null;
}

/** Sign out: delete this request's session (if any) and clear the cookie. */
export function endAdminSession(c: Context, platform: Platform): void {
  const token = readAdminToken(c, platform.hosted);
  if (token) deleteAdminSession(platform.db, token);
  clearAdminCookie(c);
}

/**
 * Owner console only: 401 `unauthorized` unless the request carries a live owner session.
 * Puts `{ email }` on `c.var.platformAdmin`.
 */
export function requirePlatformAdmin(platform: Platform) {
  return createMiddleware<PlatformAdminEnv>(async (c, next) => {
    const admin = getPlatformAdmin(c, platform);
    if (!admin) return jsonError(c, 401, 'Please sign in', 'unauthorized');
    c.set('platformAdmin', admin);
    await next();
  });
}
