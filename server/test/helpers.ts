/**
 * Test toolkit for API tests (vitest, no ports):
 *
 *   const t = makeTestApp();                       // fresh temp-file DB, migrated, set up
 *   const { headers } = await loginAsBooker(t);    // cookie headers for a new booker
 *   const show = createShow(t.db, { date: '2026-11-06' });
 *   const res = await t.request('/api/shows?from=2026-11-01&to=2026-11-30', { headers });
 *   expect(res.status).toBe(200);
 *   const body = await readJson<MyType>(res);
 *
 *   await t.request('/api/locations', { method: 'POST', headers, json: { name: 'Annex' } });
 */
import bcrypt from 'bcryptjs';
import { desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCATION_PALETTE, type Role } from '../../shared/types';
import { createApp } from '../app';
import { createSession, SESSION_COOKIES } from '../auth/sessions';
import type { AppEnv } from '../context';
import { closeDb, createDb, type Db } from '../db/client';
import * as t from '../db/schema';
import { updateSettings, type SettingsUpdate } from '../lib/settings';

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

export interface TestRequestInit extends Omit<RequestInit, 'body'> {
  /** JSON body (sets content-type). */
  json?: unknown;
  body?: RequestInit['body'];
}

export interface TestApp {
  app: Hono<AppEnv>;
  db: Db;
  dbFile: string;
  /** `app.request` with JSON conveniences. Mutating requests default to JSON content-type. */
  request(path: string, init?: TestRequestInit): Promise<Response>;
  close(): void;
}

export interface MakeTestAppOptions {
  /** Default true. Set false to test the first-run setup flow. */
  setupComplete?: boolean;
  /** Extra settings to apply (e.g. `{ timezone: 'America/Los_Angeles' }`). */
  settings?: SettingsUpdate;
}

export const TEST_APP_URL = 'http://localhost:5173';

/** A fresh app on its own migrated temp-file database. */
export function makeTestApp(options: MakeTestAppOptions = {}): TestApp {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cbp-test-'));
  tempDirs.push(dir);
  const dbFile = path.join(dir, 'club.db');
  const db = createDb(dbFile);
  updateSettings(db, {
    clubName: 'Test Comedy Club',
    timezone: 'America/New_York',
    appUrl: TEST_APP_URL,
    setupComplete: options.setupComplete ?? true,
    ...options.settings,
  });
  const app = createApp({ db });

  return {
    app,
    db,
    dbFile,
    request: async (pathname, init = {}) => {
      const { json, headers, body, ...rest } = init;
      const h = new Headers(headers);
      let payload = body;
      if (json !== undefined) {
        h.set('content-type', 'application/json');
        payload = JSON.stringify(json);
      } else if (!h.has('content-type') && rest.method && !['GET', 'HEAD'].includes(rest.method.toUpperCase())) {
        h.set('content-type', 'application/json');
      }
      return app.request(pathname, { ...rest, headers: h, body: payload });
    },
    close: () => closeDb(db),
  };
}

export async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Cookies & sessions
// ---------------------------------------------------------------------------

/** Cookie headers for `t.request(path, { headers })` (a type alias so it is a valid HeadersInit). */
export type AuthHeaders = {
  cookie: string;
};

/** `name=value; …` from a response's Set-Cookie headers (ignores cleared cookies). */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/** Merge several auth headers into one (e.g. booker + comedian in the same browser). */
export function withCookies(...headers: AuthHeaders[]): AuthHeaders {
  return { cookie: headers.map((h) => h.cookie).filter(Boolean).join('; ') };
}

export const TEST_PASSWORD = 'password123';
let cachedPasswordHash: string | undefined;
/** bcrypt hash of TEST_PASSWORD (cheap rounds, computed once). */
export function testPasswordHash(): string {
  cachedPasswordHash ??= bcrypt.hashSync(TEST_PASSWORD, 4);
  return cachedPasswordHash;
}

export interface LoginAsBookerOptions {
  role?: Role;
  email?: string;
  name?: string;
}

/** Create a booker (password TEST_PASSWORD) with a live session. */
export async function loginAsBooker(
  app: TestApp,
  options: LoginAsBookerOptions = {},
): Promise<{ user: t.User; headers: AuthHeaders; cookie: string }> {
  const user = createUser(app.db, { role: options.role ?? 'admin', email: options.email, name: options.name });
  const { token } = createSession(app.db, 'booker', user.id);
  const cookie = `${SESSION_COOKIES.booker}=${token}`;
  return { user, headers: { cookie }, cookie };
}

/** A live comedian session for an existing comedian. */
export async function loginAsComedian(
  app: TestApp,
  comedianId: number,
): Promise<{ headers: AuthHeaders; cookie: string }> {
  const { token } = createSession(app.db, 'comedian', comedianId);
  const cookie = `${SESSION_COOKIES.comedian}=${token}`;
  return { headers: { cookie }, cookie };
}

// ---------------------------------------------------------------------------
// Factories (synchronous; each returns the inserted row)
// ---------------------------------------------------------------------------

let seq = 0;
const next = () => ++seq;

export function createUser(db: Db, overrides: Partial<t.NewUser> = {}): t.User {
  const n = next();
  return db
    .insert(t.users)
    .values({
      email: overrides.email ?? `booker${n}@example.test`,
      name: overrides.name ?? `Booker ${n}`,
      role: overrides.role ?? 'booker',
      passwordHash: overrides.passwordHash === undefined ? testPasswordHash() : overrides.passwordHash,
      ...stripUndefined(overrides),
    })
    .returning()
    .get();
}

export function createLocation(db: Db, overrides: Partial<t.NewLocation> = {}): t.LocationRow {
  const n = next();
  return db
    .insert(t.locations)
    .values({
      name: `Room ${n}`,
      color: LOCATION_PALETTE[n % LOCATION_PALETTE.length]!,
      sortOrder: n,
      ...stripUndefined(overrides),
    })
    .returning()
    .get();
}

/** A scheduled show (default: Fri 2026-11-06, 9 PM, 6 slots). Creates a location if none given. */
export function createShow(db: Db, overrides: Partial<t.NewShow> = {}): t.Show {
  const locationId = overrides.locationId ?? createLocation(db).id;
  return db
    .insert(t.shows)
    .values({ date: '2026-11-06', startMin: 1260, slotCount: 6, ...stripUndefined(overrides), locationId })
    .returning()
    .get();
}

export function createComedian(db: Db, overrides: Partial<t.NewComedian> = {}): t.Comedian {
  const n = next();
  return db
    .insert(t.comedians)
    .values({ email: `comic${n}@example.test`, name: `Comic ${n}`, ...stripUndefined(overrides) })
    .returning()
    .get();
}

/** A booking in the first free position unless `position` is given. */
export function createBooking(
  db: Db,
  values: Pick<t.NewBooking, 'showId' | 'comedianId'> & Partial<t.NewBooking>,
): t.Booking {
  const taken = new Set(
    db.select({ position: t.bookings.position }).from(t.bookings).where(eq(t.bookings.showId, values.showId)).all()
      .map((b) => b.position),
  );
  let position = 0;
  while (taken.has(position)) position++;
  return db
    .insert(t.bookings)
    .values({ position, ...stripUndefined(values) })
    .returning()
    .get();
}

/** Availability for one night (default all night 7–11 PM). */
export function createAvailability(
  db: Db,
  values: Pick<t.NewAvailability, 'comedianId' | 'date'> & Partial<t.NewAvailability>,
): t.Availability {
  return db
    .insert(t.availability)
    .values({ startMin: 1140, endMin: 1380, ...stripUndefined(values) })
    .returning()
    .get();
}

export function createSubmission(db: Db, comedianId: number, month: string, submittedAt = Date.now()) {
  return db.insert(t.availabilitySubmissions).values({ comedianId, month, submittedAt }).returning().get();
}

export function createTag(db: Db, overrides: Partial<typeof t.tags.$inferInsert> = {}): t.Tag {
  const n = next();
  return db
    .insert(t.tags)
    .values({ name: `Tag ${n}`, color: LOCATION_PALETTE[n % LOCATION_PALETTE.length]!, ...stripUndefined(overrides) })
    .returning()
    .get();
}

export function tagComedian(db: Db, comedianId: number, tagId: number): void {
  db.insert(t.comedianTags).values({ comedianId, tagId }).onConflictDoNothing().run();
}

export function createNote(
  db: Db,
  values: { comedianId: number; authorId?: number | null; body?: string; createdAt?: number },
): t.Note {
  return db
    .insert(t.notes)
    .values({ body: 'Solid set.', ...stripUndefined(values) })
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** email_log rows, newest first (optionally only those sent to `to`). */
export function emailsTo(db: Db, to?: string): t.EmailLogEntry[] {
  const rows = db.select().from(t.emailLog).orderBy(desc(t.emailLog.id)).all();
  return to ? rows.filter((r) => r.toEmail === to) : rows;
}

/** The newest email_log row (optionally only to `to`), or undefined. */
export function latestEmail(db: Db, to?: string): t.EmailLogEntry | undefined {
  return emailsTo(db, to)[0];
}

// ---------------------------------------------------------------------------

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
