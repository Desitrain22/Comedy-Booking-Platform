import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

export type Schema = typeof schema;
/** The drizzle database handle. Routes get it from `c.var.db`; services take it as first arg. */
export type Db = BetterSQLite3Database<Schema> & { $client: Database.Database };
/** The handle inside `db.transaction((tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either a db or a transaction — accept this in helpers that may run inside a transaction. */
export type DbOrTx = Db | Tx;

/**
 * Migrations sit next to this module: `server/db/migrations` when running from source
 * (tsx / vitest) and `dist/server/migrations` in the bundle (tsup copies them).
 */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')];
  const found = candidates.find((dir) => existsSync(path.join(dir, 'meta', '_journal.json')));
  if (!found) throw new Error(`Database migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

export interface CreateDbOptions {
  /** Apply pending migrations (default true). */
  migrate?: boolean;
}

/**
 * Open (creating if needed) the SQLite database at `filePath` with WAL + foreign keys,
 * and apply migrations. Use ':memory:' for a throwaway in-memory DB.
 */
export function createDb(filePath: string, options: CreateDbOptions = {}): Db {
  if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle({ client: sqlite, schema });
  if (options.migrate !== false) migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
}

export function closeDb(db: Db): void {
  if (db.$client.open) db.$client.close();
}
