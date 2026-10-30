/**
 * The club registry (hosted mode, hosted MVP spec §3): the `clubs` table in platform.db and
 * a cache of open club databases (`$DATA_DIR/clubs/<id>.db`, the ordinary club schema).
 *
 *   const club = registry.getClubBySlug('broadway');          // any status, or null
 *   const db = registry.openClubDb(club);                     // cached; migrated on first open
 *   registry.setClubStatus(club.id, 'suspended', 'Unpaid');   // takes effect on the next request
 *
 * The host middleware looks the club up on every request (an indexed read), so a status
 * change applies at once without any cache to invalidate. Club databases stay open until the
 * club is archived or the registry is closed.
 *
 * Every club database gets its own sign-in rate limiter (like a single-club app) and is tagged
 * as hosted (server/lib/hosting.ts: its id, slug, the platform settings), which pins its app URL
 * to `<protocol>//<slug>.<domain>` so email links always point at the club.
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { closeDb, createDb, type Db } from '../db/client';
import type { HostedEnv } from '../env';
import { RateLimiter, setRateLimiter, type RateLimitConfig } from '../lib/rateLimit';
import { resolveRateLimits } from '../lib/rateLimitConfig';
import { setClubHosting } from '../lib/hosting';
import type { PlatformDb } from './db';
import { clubUrl } from './hosts';
import { CLUB_STATUSES, clubs, type Club, type ClubStatus } from './schema';

export interface ClubRegistryOptions {
  db: PlatformDb;
  hosted: HostedEnv;
  /** `$DATA_DIR/clubs` */
  clubsDir: string;
  /** Sign-in rate limits for every club database (default: like a single-club app). */
  clubRateLimits?: Partial<RateLimitConfig>;
}

export interface ListClubsFilter {
  /** One status, several, or 'all' (default: every status). */
  status?: ClubStatus | readonly ClubStatus[] | 'all';
  /** Case-insensitive substring of the slug, name or owner email/name. */
  search?: string;
}

export interface NewClubInput {
  /** Already validated (shared/api/platform.ts `slugSchema`). */
  slug: string;
  name: string;
  ownerName: string;
  ownerEmail: string;
}

/** Thrown by createClub when the slug is taken (by a club of any status). */
export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`The address ${slug} is taken`);
    this.name = 'SlugTakenError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class ClubRegistry {
  readonly db: PlatformDb;
  readonly clubsDir: string;
  readonly hosted: HostedEnv;
  private readonly clubRateLimits: RateLimitConfig;
  private readonly open = new Map<number, Db>();

  constructor(options: ClubRegistryOptions) {
    this.db = options.db;
    this.hosted = options.hosted;
    this.clubsDir = options.clubsDir;
    this.clubRateLimits = resolveRateLimits(options.clubRateLimits);
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** The club at this address (any status), or null. `slug` is compared lowercased. */
  getClubBySlug(slug: string): Club | null {
    return this.db.select().from(clubs).where(eq(clubs.slug, slug.trim().toLowerCase())).get() ?? null;
  }

  getClubById(id: number): Club | null {
    return this.db.select().from(clubs).where(eq(clubs.id, id)).get() ?? null;
  }

  /** Clubs, oldest first. */
  listClubs(filter: ListClubsFilter = {}): Club[] {
    const where: SQL[] = [];
    const { status = 'all', search } = filter;
    if (status !== 'all') {
      const statuses = (typeof status === 'string' ? [status] : status).filter((s) => CLUB_STATUSES.includes(s));
      if (!statuses.length) return [];
      where.push(inArray(clubs.status, statuses));
    }
    const rows = this.db
      .select()
      .from(clubs)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(clubs.createdAt), asc(clubs.id))
      .all();
    const q = search?.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((club) =>
      [club.slug, club.name, club.ownerEmail, club.ownerName].some((value) => value.toLowerCase().includes(q)),
    );
  }

  /** `<protocol>//<slug>.<domain>` */
  clubUrl(club: Pick<Club, 'slug'>): string {
    return clubUrl(this.hosted, club.slug);
  }

  /** Where this club's database lives: `<clubsDir>/<id>.db`. */
  clubDbFile(id: number): string {
    return path.join(this.clubsDir, `${id}.db`);
  }

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  /**
   * Register a club and create its (migrated) database. `init` runs on the new database
   * before this returns (sign-up runs the setup there); if it throws, the club is rolled
   * back — database file and registry row removed, the slug free again — and the error
   * rethrown. Throws SlugTakenError when the slug is taken.
   */
  createClub<T = void>(input: NewClubInput, init?: (db: Db, club: Club) => T): { club: Club; db: Db; result: T } {
    let club: Club;
    try {
      club = this.db
        .insert(clubs)
        .values({
          slug: input.slug.trim().toLowerCase(),
          name: input.name,
          ownerName: input.ownerName,
          ownerEmail: input.ownerEmail.trim().toLowerCase(),
          statusChangedAt: Date.now(),
        })
        .returning()
        .get();
    } catch (err) {
      if (isUniqueViolation(err)) throw new SlugTakenError(input.slug);
      throw err;
    }
    try {
      // A file already there belongs to no registered club (e.g. platform.db was restored
      // from an older copy): keep it aside, never hand its data to the new club.
      this.moveAsideDbFiles(club.id);
      const db = this.openClubDb(club);
      const result = init ? init(db, club) : (undefined as T);
      return { club, db, result };
    } catch (err) {
      this.closeClubDb(club.id);
      this.removeDbFiles(club.id);
      this.db.delete(clubs).where(eq(clubs.id, club.id)).run();
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Databases
  // -------------------------------------------------------------------------

  /**
   * The club's database, opened (and migrated) on first use, then cached. Opens it whatever
   * the club's status: callers decide who may use it (the host middleware refuses suspended
   * and archived clubs).
   */
  openClubDb(club: Pick<Club, 'id' | 'slug'> | number): Db {
    const row = typeof club === 'number' ? this.getClubById(club) : club;
    if (!row) throw new Error(`No club with id ${String(club)}`);
    const cached = this.open.get(row.id);
    if (cached?.$client.open) return cached;
    mkdirSync(this.clubsDir, { recursive: true });
    const db = createDb(this.clubDbFile(row.id));
    setRateLimiter(db, new RateLimiter(this.clubRateLimits));
    setClubHosting(db, { hosted: this.hosted, clubId: row.id, slug: row.slug, clubUrl: this.clubUrl(row) });
    this.open.set(row.id, db);
    return db;
  }

  /** Close the club's database if it is open (the next openClubDb reopens it). */
  closeClubDb(id: number): void {
    const db = this.open.get(id);
    if (!db) return;
    this.open.delete(id);
    closeDb(db);
  }

  /** Ids of the club databases open right now. */
  openClubIds(): number[] {
    return [...this.open.keys()];
  }

  /** Close every open club database (shutdown). */
  closeAll(): void {
    for (const id of [...this.open.keys()]) this.closeClubDb(id);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Suspend, archive or reactivate a club. `reason` is the owner's note (never shown to the
   * club; '' clears it). Archiving closes the club's database; its slug stays taken.
   * Returns the updated row, or null when there is no such club.
   */
  setClubStatus(id: number, status: ClubStatus, reason = ''): Club | null {
    const updated =
      this.db
        .update(clubs)
        .set({ status, statusReason: reason, statusChangedAt: Date.now() })
        .where(eq(clubs.id, id))
        .returning()
        .get() ?? null;
    if (updated && status === 'archived') this.closeClubDb(id);
    return updated;
  }

  private moveAsideDbFiles(id: number): void {
    const file = this.clubDbFile(id);
    if (!existsSync(file)) return;
    const aside = `${file}.orphaned-${Date.now()}`;
    console.warn(`[registry] ${file} belongs to no club; moved to ${aside}`);
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    }
  }

  private removeDbFiles(id: number): void {
    const file = this.clubDbFile(id);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (existsSync(file + suffix)) rmSync(file + suffix, { force: true });
    }
  }
}
