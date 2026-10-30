/**
 * The platform registry database (hosted mode): `$DATA_DIR/platform.db`, its own schema
 * (./schema.ts) and migrations (./migrations; `dist/server/platform-migrations` in the bundle).
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as platformSchema from './schema';

export type PlatformSchema = typeof platformSchema;
export type PlatformDb = BetterSQLite3Database<PlatformSchema> & { $client: Database.Database };

export function platformMigrationsFolder(): string {
  if (process.env.PLATFORM_MIGRATIONS_DIR) return path.resolve(process.env.PLATFORM_MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The bundle first: dist/server/migrations exists there too, but holds the CLUB migrations.
  const candidates = [path.join(here, 'platform-migrations'), path.join(here, 'migrations')];
  const found = candidates.find((dir) => existsSync(path.join(dir, 'meta', '_journal.json')));
  if (!found) throw new Error(`Platform migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** Open (creating if needed) and migrate the platform database. ':memory:' for tests. */
export function createPlatformDb(filePath: string): PlatformDb {
  if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle({ client: sqlite, schema: platformSchema });
  migrate(db, { migrationsFolder: platformMigrationsFolder() });
  return db;
}

export function closePlatformDb(db: PlatformDb): void {
  if (db.$client.open) db.$client.close();
}
