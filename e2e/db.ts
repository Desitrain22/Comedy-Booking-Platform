/**
 * The club database behind the server the current Playwright project runs against: its
 * `metadata.dataDir` (playwright.config.ts — or E2E_DATA_DIR for a server you started). Specs
 * read sign-in codes and links from its email log and check what got saved. Call these inside a
 * test or hook.
 */
import { test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

export function clubDbFile(): string {
  const { dataDir } = test.info().project.metadata as { dataDir?: string };
  return path.resolve(dataDir ?? process.env.E2E_DATA_DIR ?? '.data/e2e', 'club.db');
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
