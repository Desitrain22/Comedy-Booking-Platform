/**
 * Cookie sessions. Two independent cookies so a booker can test the portal in the same
 * browser: `cbp_booker` (30 days) and `cbp_comedian` (90 days). The cookie holds a random
 * token; the DB stores only its sha256.
 *
 * Over https (the app URL is https, or the request came in over https) the cookies are
 * `Secure` and named `__Host-cbp_booker` / `__Host-cbp_comedian`: the browser then only
 * keeps them for this exact host, so a sibling subdomain can't set or overwrite them.
 */
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SessionKind } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { sessions } from '../db/schema';
import { getAppUrl } from '../lib/settings';
import { randomToken, sha256Hex } from './crypto';
import { isHttpsRequest } from './request';

const DAY = 86_400_000;

/** Cookie names (over https they get the `__Host-` prefix, see `sessionCookieName`). */
export const SESSION_COOKIES: Record<SessionKind, string> = {
  booker: 'cbp_booker',
  comedian: 'cbp_comedian',
};

/** The prefix https session cookies carry. */
export const SECURE_COOKIE_PREFIX = '__Host-';

export const SESSION_TTL_MS: Record<SessionKind, number> = {
  booker: 30 * DAY,
  comedian: 90 * DAY,
};

export interface NewSession {
  token: string;
  expiresAt: number;
}

export interface SessionOptions {
  /** Shorter (or longer) than the default for this kind, e.g. a session started by an emailed link. */
  ttlMs?: number;
}

export function createSession(
  db: DbOrTx,
  kind: SessionKind,
  subjectId: number,
  options: SessionOptions = {},
): NewSession {
  const token = randomToken();
  const expiresAt = Date.now() + (options.ttlMs ?? SESSION_TTL_MS[kind]);
  db.insert(sessions).values({ id: sha256Hex(token), kind, subjectId, expiresAt }).run();
  return { token, expiresAt };
}

/** The subject id for a live session token of this kind, or null. */
export function findSessionSubject(db: DbOrTx, kind: SessionKind, token: string): number | null {
  const row = db
    .select({ subjectId: sessions.subjectId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.id, sha256Hex(token)), eq(sessions.kind, kind)))
    .get();
  if (!row || row.expiresAt <= Date.now()) return null;
  return row.subjectId;
}

export function deleteSession(db: DbOrTx, token: string): void {
  db.delete(sessions).where(eq(sessions.id, sha256Hex(token))).run();
}

/** Sign someone out everywhere (e.g. when a booker is removed or a comedian archived). */
export function deleteSessionsFor(db: DbOrTx, kind: SessionKind, subjectId: number): void {
  db.delete(sessions)
    .where(and(eq(sessions.kind, kind), eq(sessions.subjectId, subjectId)))
    .run();
}

/** Sign someone out everywhere except the session holding `keepToken` (e.g. after a password change). */
export function deleteOtherSessions(db: DbOrTx, kind: SessionKind, subjectId: number, keepToken: string): number {
  return db
    .delete(sessions)
    .where(and(eq(sessions.kind, kind), eq(sessions.subjectId, subjectId), ne(sessions.id, sha256Hex(keepToken))))
    .run().changes;
}

export function deleteExpiredSessions(db: DbOrTx, now = Date.now()): number {
  return db.delete(sessions).where(lt(sessions.expiresAt, now)).run().changes;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** Secure cookies when the app is served over https (its URL, or this very request). */
export function wantsSecureCookies(c: Context, db: DbOrTx): boolean {
  return getAppUrl(db).startsWith('https://') || isHttpsRequest(c);
}

/** The cookie name for this kind on this request: `__Host-cbp_booker` over https, else `cbp_booker`. */
export function sessionCookieName(c: Context, db: DbOrTx, kind: SessionKind): string {
  return wantsSecureCookies(c, db) ? `${SECURE_COOKIE_PREFIX}${SESSION_COOKIES[kind]}` : SESSION_COOKIES[kind];
}

/**
 * The session token from this request's cookie. Over https only the `__Host-` cookie
 * counts (a plain one could have been planted by a sibling subdomain).
 */
export function readSessionToken(c: Context, kind: SessionKind): string | undefined {
  const db = (c.var as { db?: DbOrTx }).db;
  const secure = db ? wantsSecureCookies(c, db) : false;
  return (secure ? getCookie(c, SESSION_COOKIES[kind], 'host') : getCookie(c, SESSION_COOKIES[kind])) || undefined;
}

export function setSessionCookie(c: Context, db: DbOrTx, kind: SessionKind, session: NewSession): void {
  const options = {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(session.expiresAt),
    maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
  } as const;
  if (wantsSecureCookies(c, db)) {
    setCookie(c, SESSION_COOKIES[kind], session.token, { ...options, secure: true, prefix: 'host' });
    // Drop a pre-https plain cookie so the browser doesn't keep sending both.
    if (getCookie(c, SESSION_COOKIES[kind]) !== undefined) deleteCookie(c, SESSION_COOKIES[kind], { path: '/' });
  } else {
    setCookie(c, SESSION_COOKIES[kind], session.token, { ...options, secure: false });
  }
}

/** Clear both spellings of the cookie (whichever this browser has). */
export function clearSessionCookie(c: Context, kind: SessionKind): void {
  deleteCookie(c, SESSION_COOKIES[kind], { path: '/' });
  if (getCookie(c, SESSION_COOKIES[kind], 'host') !== undefined) {
    deleteCookie(c, SESSION_COOKIES[kind], { path: '/', secure: true, prefix: 'host' });
  }
}

/** Create a session and set its cookie on the response. */
export function signIn(
  c: Context,
  db: DbOrTx,
  kind: SessionKind,
  subjectId: number,
  options: SessionOptions = {},
): NewSession {
  const session = createSession(db, kind, subjectId, options);
  setSessionCookie(c, db, kind, session);
  return session;
}

/** Delete the current session of this kind (if any) and clear its cookie. */
export function signOut(c: Context, db: DbOrTx, kind: SessionKind): void {
  const token = readSessionToken(c, kind);
  if (token) deleteSession(db, token);
  clearSessionCookie(c, kind);
}
