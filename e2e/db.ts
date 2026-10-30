/**
 * The club database behind the server the current Playwright project runs against: its
 * `metadata.dataDir` (playwright.config.ts — or E2E_DATA_DIR for a server you started). Specs
 * read sign-in codes and links from its email log and check what got saved. Call these inside a
 * test or hook.
 *
 * Hosted mode (the `hosted` project): `withPlatformDb` opens `platform.db` (the club registry,
 * the platform email log), `withHostedClubDb(slug, …)` one club's `clubs/<id>.db`, and
 * `setClubStatus(slug, …)` suspends / archives / reactivates a club like the owner console.
 * `latestAdminCode(email)` reads the newest owner-console sign-in code from the platform email
 * log, and `adminEventsFor(slug)` the console's actions on a club.
 */
import { test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

function dataDir(): string {
  const { dataDir } = test.info().project.metadata as { dataDir?: string };
  return path.resolve(dataDir ?? process.env.E2E_DATA_DIR ?? '.data/e2e');
}

export function clubDbFile(): string {
  return path.join(dataDir(), 'club.db');
}

export function withClubDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(clubDbFile());
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Hosted mode
// ---------------------------------------------------------------------------

function open<T>(file: string, fn: (db: Database.Database) => T): T {
  const db = new Database(file, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function platformDbFile(): string {
  return path.join(dataDir(), 'platform.db');
}

export function withPlatformDb<T>(fn: (db: Database.Database) => T): T {
  return open(platformDbFile(), fn);
}

/** The registry id of the club at `slug` (throws when there is none). */
export function hostedClubId(slug: string): number {
  const row = withPlatformDb((db) => db.prepare('SELECT id FROM clubs WHERE slug = ?').get(slug) as { id: number } | undefined);
  if (!row) throw new Error(`No hosted club ${slug}`);
  return row.id;
}

export function withHostedClubDb<T>(slug: string, fn: (db: Database.Database) => T): T {
  return open(path.join(dataDir(), 'clubs', `${hostedClubId(slug)}.db`), fn);
}

/** Suspend, archive or reactivate a hosted club (the server reads the status on every request). */
export function setClubStatus(slug: string, status: 'active' | 'suspended' | 'archived', reason = ''): void {
  withPlatformDb((db) => {
    const changed = db
      .prepare('UPDATE clubs SET status = ?, status_reason = ?, status_changed_at = ? WHERE slug = ?')
      .run(status, reason, Date.now(), slug).changes;
    if (changed !== 1) throw new Error(`No hosted club ${slug}`);
  });
}

/**
 * The newest owner-console sign-in code emailed to `email` (outbox rows keep the body), with
 * its email's id (to tell a new code from the last one), or null.
 */
export function latestAdminCode(email: string): { id: number; code: string } | null {
  const row = withPlatformDb(
    (db) =>
      db
        .prepare(
          `SELECT id, body_text FROM platform_email_log WHERE kind = 'admin_login_code' AND to_email = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(email.toLowerCase()) as { id: number; body_text: string } | undefined,
  );
  const code = /\b(\d{6})\b/.exec(row?.body_text ?? '')?.[1];
  return row && code ? { id: row.id, code } : null;
}

/** The owner console's actions on the club at `slug`, oldest first. */
export function adminEventsFor(slug: string): { action: string; admin_email: string; reason: string }[] {
  const id = hostedClubId(slug);
  return withPlatformDb(
    (db) =>
      db
        .prepare('SELECT action, admin_email, reason FROM admin_events WHERE club_id = ? ORDER BY id')
        .all(id) as { action: string; admin_email: string; reason: string }[],
  );
}
