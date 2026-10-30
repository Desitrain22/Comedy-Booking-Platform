/**
 * F3 — Comedians, tags, notes. All routes are booker-only (`requireBooker`); request and
 * response shapes live in `shared/api/comedians.ts` (endpoint list at the top of that file).
 *
 * Rules worth knowing:
 * - Emails are unique and stored lowercased; clashes → 409 `email_taken` with the
 *   existing comedian in `existing`.
 * - Archived comedians are hidden from `GET /comedians` unless `archived=1`, and their
 *   sessions are revoked (foundation auth already refuses archived sign-ins). They are never
 *   emailed sign-in links.
 * - Changing a comedian's email revokes everything tied to the old address: sessions,
 *   magic/confirmation link tokens and login codes.
 * - Adding comedians can email them a sign-in link right away (`sendLoginLink(s)`).
 * - Bulk add / CSV import (`POST /comedians/bulk`): up to 1,000 rows; every row is checked on
 *   its own (bad rows are skipped with a reason), existing emails are skipped and never
 *   overwritten, and a row's note becomes a booker note by the importing booker. It has its
 *   own body limit (BULK_ADD_BODY_MAX_BYTES), larger than the rest of the API's.
 * - Phone numbers are optional and stored as typed (trimmed; `phoneSchema`).
 * - Notes: any booker can add; only the author or an admin can edit/delete (403 `forbidden`).
 * - Tag names are unique case-insensitively → 409 `tag_exists`.
 */
import { and, asc, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  BULK_ADD_BODY_MAX_BYTES,
  bulkAddSchema,
  bulkArchiveSchema,
  bulkSendLoginLinkSchema,
  bulkRowIssues,
  bulkTagSchema,
  CARD_NOTE_COUNT,
  comedianAvailabilityQuerySchema,
  comedianBookingsQuerySchema,
  createComedianSchema,
  createTagSchema,
  firstBulkReason,
  listComediansQuerySchema,
  nextTagColor,
  normalizeBulkRow,
  noteBodySchema,
  setComedianTagsSchema,
  updateComedianSchema,
  updateTagSchema,
  type BulkAddResult,
  type BulkCreated,
  type BulkLoginLinkResult,
  type BulkSkip,
  type BulkSkipReason,
  type BulkUpdateResult,
  type ComedianAvailability,
  type ComedianBooking,
  type ComedianCard,
  type ComedianDetail,
  type ComedianListItem,
  type CreateComedianResponse,
  type LoginLinkResult,
  type NoteDto,
  type SendLoginLinkResponse,
  type TagSummary,
  type TagWithCount,
} from '../../shared/api/comedians';
import { bookingStatus } from '../../shared/bookingStatus';
import { normalizeEmail } from '../../shared/schemas';
import { firstDayOfMonth, lastDayOfMonth, planningMonth } from '../../shared/time';
import { requireBooker } from '../auth/middleware';
import { deleteSessionsFor } from '../auth/sessions';
import { createLoginLink } from '../auth/tokens';
import type { AppEnv, SessionBooker } from '../context';
import type { Db, DbOrTx } from '../db/client';
import {
  availability,
  availabilitySubmissions,
  bookings,
  comedians,
  comedianTags,
  locations,
  loginCodes,
  notes,
  shows,
  tags,
  tokens,
  users,
  type Comedian,
} from '../db/schema';
import { sendEmail } from '../email/mailer';
import { loginLinkEmail } from '../email/templates';
import { httpError, orNotFound, parseId } from '../lib/http';
import { clubNight, clubToday, getAllNightRange, getSettings } from '../lib/settings';
import { validate } from '../lib/validate';
import { EMAIL_CONCURRENCY, mapWithConcurrency } from '../services/batch';

export const comediansRoutes = new Hono<AppEnv>();

/**
 * The bulk add / CSV import endpoint. `server/app.ts` skips the global body limit for this
 * path because the route applies its own, larger one (a 2 MB CSV of 1,000 comedians).
 */
export const BULK_ADD_PATH = '/api/comedians/bulk';

const bulkAddBodyLimit = bodyLimit({
  maxSize: BULK_ADD_BODY_MAX_BYTES,
  onError: (c) =>
    c.json({ error: 'That import is too large. Split the file and import it in parts.', code: 'payload_too_large' }, 413),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `LIKE` pattern for a substring match, with %, _ and \ escaped. */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function findComedian(db: DbOrTx, id: number): Comedian {
  return orNotFound(db.select().from(comedians).where(eq(comedians.id, id)).get(), 'Comedian');
}

/** 409 `email_taken` if another comedian already uses `email`. */
function assertEmailFree(db: DbOrTx, email: string, exceptId?: number): void {
  const existing = db
    .select({ id: comedians.id, name: comedians.name, archived: comedians.archived })
    .from(comedians)
    .where(eq(comedians.email, normalizeEmail(email)))
    .get();
  if (existing && existing.id !== exceptId) {
    const where = existing.archived ? ' (archived)' : '';
    throw httpError(409, `${existing.name}${where} already uses that email`, 'email_taken', { existing });
  }
}

/** comedianId → tags (sorted by name). Pass ids to limit the lookup. */
function tagsByComedian(db: DbOrTx, comedianIds?: number[]): Map<number, TagSummary[]> {
  const map = new Map<number, TagSummary[]>();
  if (comedianIds && comedianIds.length === 0) return map;
  const rows = db
    .select({ comedianId: comedianTags.comedianId, id: tags.id, name: tags.name, color: tags.color })
    .from(comedianTags)
    .innerJoin(tags, eq(tags.id, comedianTags.tagId))
    .where(comedianIds ? inArray(comedianTags.comedianId, comedianIds) : undefined)
    .orderBy(sql`${tags.name} COLLATE NOCASE`)
    .all();
  for (const { comedianId, ...tag } of rows) {
    const list = map.get(comedianId);
    if (list) list.push(tag);
    else map.set(comedianId, [tag]);
  }
  return map;
}

/** comedianId → number of bookings on scheduled shows dated today or later. */
function upcomingCounts(db: DbOrTx, today: string, comedianIds?: number[]): Map<number, number> {
  if (comedianIds && comedianIds.length === 0) return new Map();
  const rows = db
    .select({ comedianId: bookings.comedianId, n: count() })
    .from(bookings)
    .innerJoin(shows, eq(shows.id, bookings.showId))
    .where(
      and(
        gte(shows.date, today),
        eq(shows.status, 'scheduled'),
        comedianIds ? inArray(bookings.comedianId, comedianIds) : undefined,
      ),
    )
    .groupBy(bookings.comedianId)
    .all();
  return new Map(rows.map((r) => [r.comedianId, r.n]));
}

function toDetail(db: DbOrTx, comedian: Comedian): ComedianDetail {
  const today = clubToday(db);
  return {
    id: comedian.id,
    name: comedian.name,
    email: comedian.email,
    phone: comedian.phone,
    bio: comedian.bio,
    headshotUrl: comedian.headshotUrl,
    archived: comedian.archived,
    tags: tagsByComedian(db, [comedian.id]).get(comedian.id) ?? [],
    upcomingCount: upcomingCounts(db, today, [comedian.id]).get(comedian.id) ?? 0,
    createdAt: comedian.createdAt,
    updatedAt: comedian.updatedAt,
    lastLoginAt: comedian.lastLoginAt,
  };
}

const noteColumns = {
  id: notes.id,
  comedianId: notes.comedianId,
  body: notes.body,
  authorId: notes.authorId,
  authorName: users.name,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
};

type NoteRow = Omit<NoteDto, 'canEdit'>;

function canEditNote(booker: SessionBooker, note: { authorId: number | null }): boolean {
  return booker.role === 'admin' || note.authorId === booker.id;
}

function withCanEdit(booker: SessionBooker, row: NoteRow): NoteDto {
  return { ...row, canEdit: canEditNote(booker, row) };
}

function selectNotes(db: DbOrTx, where: SQL | undefined, limit?: number): NoteRow[] {
  const query = db
    .select(noteColumns)
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorId))
    .where(where)
    .orderBy(desc(notes.createdAt), desc(notes.id));
  return limit === undefined ? query.all() : query.limit(limit).all();
}

function findNote(db: DbOrTx, id: number): NoteRow {
  return orNotFound(selectNotes(db, eq(notes.id, id))[0], 'Note');
}

function selectBookings(db: DbOrTx, where: SQL | undefined, order: 'asc' | 'desc'): ComedianBooking[] {
  const today = clubNight(db);
  const dir = order === 'asc' ? asc : desc;
  return db
    .select({
      id: bookings.id,
      showId: shows.id,
      date: shows.date,
      startMin: shows.startMin,
      showName: shows.name,
      showStatus: shows.status,
      position: bookings.position,
      locationId: locations.id,
      locationName: locations.name,
      locationColor: locations.color,
      locationAddress: locations.address,
      overrideUnavailable: bookings.overrideUnavailable,
      confirmationSentAt: bookings.confirmationSentAt,
      confirmedAt: bookings.confirmedAt,
      declinedAt: bookings.declinedAt,
    })
    .from(bookings)
    .innerJoin(shows, eq(shows.id, bookings.showId))
    .innerJoin(locations, eq(locations.id, shows.locationId))
    .where(where)
    .orderBy(dir(shows.date), dir(shows.startMin), asc(locations.sortOrder))
    .all()
    .map(({ locationId, locationName, locationColor, locationAddress, ...b }) => ({
      ...b,
      location: { id: locationId, name: locationName, color: locationColor, address: locationAddress },
      status: bookingStatus(b, b.date, today),
    }));
}

function tagWithCount(db: DbOrTx, where?: SQL): TagWithCount[] {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
      memberCount: sql<number>`count(${comedians.id})`.mapWith(Number),
    })
    .from(tags)
    .leftJoin(comedianTags, eq(comedianTags.tagId, tags.id))
    .leftJoin(comedians, and(eq(comedians.id, comedianTags.comedianId), eq(comedians.archived, false)))
    .where(where)
    .groupBy(tags.id)
    .orderBy(sql`${tags.name} COLLATE NOCASE`)
    .all();
}

function findTag(db: DbOrTx, id: number): TagWithCount {
  return orNotFound(tagWithCount(db, eq(tags.id, id))[0], 'Tag');
}

/** 409 `tag_exists` if another tag has this name (case-insensitive). */
function assertTagNameFree(db: DbOrTx, name: string, exceptId?: number): void {
  const existing = db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(sql`lower(${tags.name}) = lower(${name})`)
    .get();
  if (existing && existing.id !== exceptId) {
    throw httpError(409, `There's already a tag called "${existing.name}"`, 'tag_exists', { existing });
  }
}

/** Email one comedian a portal sign-in link (a fresh 30-day magic link). Never throws. */
async function sendLoginLink(db: Db, comedian: Pick<Comedian, 'id' | 'name' | 'email'>): Promise<LoginLinkResult> {
  const url = createLoginLink(db, comedian.id);
  const content = loginLinkEmail({ clubName: getSettings(db).clubName, name: comedian.name, url });
  const result = await sendEmail(db, { to: comedian.email, ...content, kind: 'login_link', comedianId: comedian.id });
  return { status: result.status, ...(result.error ? { error: result.error } : {}) };
}

/** Sign-in links for many comedians (a few at a time); archived ones are skipped. */
async function sendLoginLinks(
  db: Db,
  list: Pick<Comedian, 'id' | 'name' | 'email' | 'archived'>[],
): Promise<BulkLoginLinkResult> {
  const active = list.filter((c) => !c.archived);
  const results = await mapWithConcurrency(active, EMAIL_CONCURRENCY, (comedian) => sendLoginLink(db, comedian));
  return {
    sent: results.filter((r) => r.status === 'sent').length,
    outbox: results.filter((r) => r.status === 'outbox').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: list.length - active.length,
  };
}

/**
 * Everything that signs a comedian in and was tied to their old email: sessions, magic-link
 * and confirmation-link tokens, and login codes (security: a changed address must not keep
 * working for whoever reads the old inbox).
 */
function revokeComedianAccess(db: DbOrTx, comedianId: number): void {
  deleteSessionsFor(db, 'comedian', comedianId);
  db.delete(tokens).where(eq(tokens.comedianId, comedianId)).run();
  db.delete(loginCodes).where(eq(loginCodes.comedianId, comedianId)).run();
}

/** 400 `unknown_comedian` unless every id exists. */
function assertComediansExist(db: DbOrTx, ids: number[]): void {
  const unique = [...new Set(ids)];
  const found = db.select({ id: comedians.id }).from(comedians).where(inArray(comedians.id, unique)).all();
  if (found.length !== unique.length) {
    const known = new Set(found.map((r) => r.id));
    const missing = unique.filter((id) => !known.has(id));
    throw httpError(400, `Unknown comedian ids: ${missing.join(', ')}`, 'unknown_comedian', { missing });
  }
}

// ---------------------------------------------------------------------------
// Comedians
// ---------------------------------------------------------------------------

comediansRoutes.get('/comedians', requireBooker, validate('query', listComediansQuerySchema), (c) => {
  const db = c.var.db;
  const { search, tagIds, archived } = c.req.valid('query');
  const today = clubToday(db);
  const planning = planningMonth(today);

  const filters: (SQL | undefined)[] = [];
  if (!archived) filters.push(eq(comedians.archived, false));
  if (search) {
    const pattern = likePattern(search);
    filters.push(
      sql`(${comedians.name} LIKE ${pattern} ESCAPE '\\' OR ${comedians.email} LIKE ${pattern} ESCAPE '\\' OR ${comedians.phone} LIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (tagIds.length) {
    filters.push(
      inArray(
        comedians.id,
        db.select({ id: comedianTags.comedianId }).from(comedianTags).where(inArray(comedianTags.tagId, tagIds)),
      ),
    );
  }

  const rows = db
    .select()
    .from(comedians)
    .where(and(...filters))
    .orderBy(sql`${comedians.name} COLLATE NOCASE`, asc(comedians.id))
    .all();

  const tagMap = tagsByComedian(db);
  const counts = upcomingCounts(db, today);
  const submitted = new Set(
    db
      .select({ comedianId: availabilitySubmissions.comedianId })
      .from(availabilitySubmissions)
      .where(eq(availabilitySubmissions.month, planning))
      .all()
      .map((r) => r.comedianId),
  );

  const list: ComedianListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    headshotUrl: r.headshotUrl,
    archived: r.archived,
    tags: tagMap.get(r.id) ?? [],
    planningMonthSubmitted: submitted.has(r.id),
    upcomingCount: counts.get(r.id) ?? 0,
    lastLoginAt: r.lastLoginAt,
    createdAt: r.createdAt,
  }));
  return c.json(list);
});

comediansRoutes.post('/comedians', requireBooker, validate('json', createComedianSchema), async (c) => {
  const db = c.var.db;
  const { name, email, phone = '', sendLoginLink: invite = false } = c.req.valid('json');
  assertEmailFree(db, email);
  const comedian = db.insert(comedians).values({ name, email, phone }).returning().get();
  const loginLink = invite ? await sendLoginLink(db, comedian) : null;
  return c.json({ ...toDetail(db, comedian), loginLink } satisfies CreateComedianResponse, 201);
});

comediansRoutes.post(
  '/comedians/bulk',
  requireBooker,
  bulkAddBodyLimit,
  validate('json', bulkAddSchema),
  async (c) => {
    const db = c.var.db;
    const booker = c.var.booker;
    const { rows, dryRun = false, sendLoginLinks: invite = false } = c.req.valid('json');
    const issues = bulkRowIssues(rows);
    const normalized = rows.map(normalizeBulkRow);

    // Emails already on the roster (archived or not) are skipped, never overwritten.
    const candidateEmails = [
      ...new Set(normalized.filter((_, i) => !issues[i]!.includes('invalid_email')).map((r) => r.email)),
    ];
    const existing = new Map(
      candidateEmails.length
        ? db
            .select({ id: comedians.id, name: comedians.name, email: comedians.email, archived: comedians.archived })
            .from(comedians)
            .where(inArray(comedians.email, candidateEmails))
            .all()
            .map(({ email, ...rest }) => [email, rest])
        : [],
    );

    const skipped: BulkSkip[] = [];
    const toCreate: Omit<BulkCreated, 'id'>[] = [];
    normalized.forEach((row, index) => {
      const taken = existing.get(row.email);
      const reasons: BulkSkipReason[] = taken ? [...issues[index]!, 'email_taken'] : issues[index]!;
      const reason = firstBulkReason(reasons);
      if (reason) {
        skipped.push({ index, row: rows[index]!, reason, ...(reason === 'email_taken' && taken ? { existing: taken } : {}) });
        return;
      }
      toCreate.push({ index, ...row });
    });

    let created: BulkCreated[] = toCreate.map((r) => ({ ...r, id: 0 }));
    if (!dryRun && toCreate.length) {
      created = db.transaction((tx) =>
        toCreate.map((r) => {
          const { id } = tx
            .insert(comedians)
            .values({ name: r.name, email: r.email, phone: r.phone })
            .returning({ id: comedians.id })
            .get();
          // Same as a note added by hand: private, authored by this booker.
          if (r.note) tx.insert(notes).values({ comedianId: id, authorId: booker.id, body: r.note }).run();
          return { ...r, id };
        }),
      );
    }
    const loginLinks =
      !dryRun && invite && created.length
        ? await sendLoginLinks(
            db,
            created.map((r) => ({ id: r.id, name: r.name, email: r.email, archived: false })),
          )
        : null;
    const result: BulkAddResult = { dryRun, created, skipped, loginLinks };
    return c.json(result, dryRun || created.length === 0 ? 200 : 201);
  },
);

comediansRoutes.post('/comedians/bulk-tag', requireBooker, validate('json', bulkTagSchema), (c) => {
  const db = c.var.db;
  const { comedianIds, tagId, action } = c.req.valid('json');
  findTag(db, tagId);
  assertComediansExist(db, comedianIds);
  const ids = [...new Set(comedianIds)];
  const updated = db.transaction((tx) => {
    if (action === 'remove') {
      return tx
        .delete(comedianTags)
        .where(and(eq(comedianTags.tagId, tagId), inArray(comedianTags.comedianId, ids)))
        .run().changes;
    }
    return tx
      .insert(comedianTags)
      .values(ids.map((comedianId) => ({ comedianId, tagId })))
      .onConflictDoNothing()
      .run().changes;
  });
  return c.json({ updated } satisfies BulkUpdateResult);
});

comediansRoutes.post('/comedians/bulk-archive', requireBooker, validate('json', bulkArchiveSchema), (c) => {
  const db = c.var.db;
  const { comedianIds, archived } = c.req.valid('json');
  assertComediansExist(db, comedianIds);
  const ids = [...new Set(comedianIds)];
  const updated = db.transaction((tx) => {
    const changed = tx
      .update(comedians)
      .set({ archived })
      .where(and(inArray(comedians.id, ids), eq(comedians.archived, !archived)))
      .run().changes;
    if (archived) for (const id of ids) deleteSessionsFor(tx, 'comedian', id);
    return changed;
  });
  return c.json({ updated } satisfies BulkUpdateResult);
});

comediansRoutes.post(
  '/comedians/bulk-send-login-link',
  requireBooker,
  validate('json', bulkSendLoginLinkSchema),
  async (c) => {
    const db = c.var.db;
    const ids = [...new Set(c.req.valid('json').comedianIds)];
    assertComediansExist(db, ids);
    const list = db
      .select({ id: comedians.id, name: comedians.name, email: comedians.email, archived: comedians.archived })
      .from(comedians)
      .where(inArray(comedians.id, ids))
      .orderBy(asc(comedians.id))
      .all();
    return c.json((await sendLoginLinks(db, list)) satisfies BulkLoginLinkResult);
  },
);

comediansRoutes.get('/comedians/:id', requireBooker, (c) => {
  const db = c.var.db;
  return c.json(toDetail(db, findComedian(db, parseId(c.req.param('id')))));
});

comediansRoutes.patch('/comedians/:id', requireBooker, validate('json', updateComedianSchema), (c) => {
  const db = c.var.db;
  const comedian = findComedian(db, parseId(c.req.param('id')));
  const patch = c.req.valid('json');
  if (Object.keys(patch).length === 0) throw httpError(400, 'Nothing to update', 'validation_error');
  const newEmail = patch.email !== undefined && patch.email !== comedian.email ? patch.email : null;
  if (newEmail) assertEmailFree(db, newEmail, comedian.id);

  const updated = db.transaction((tx) => {
    const row = tx.update(comedians).set(patch).where(eq(comedians.id, comedian.id)).returning().get();
    if (newEmail) revokeComedianAccess(tx, comedian.id);
    else if (patch.archived === true) deleteSessionsFor(tx, 'comedian', comedian.id);
    return row;
  });
  return c.json(toDetail(db, updated));
});

comediansRoutes.put('/comedians/:id/tags', requireBooker, validate('json', setComedianTagsSchema), (c) => {
  const db = c.var.db;
  const comedian = findComedian(db, parseId(c.req.param('id')));
  const tagIds = [...new Set(c.req.valid('json').tagIds)];
  if (tagIds.length) {
    const known = new Set(db.select({ id: tags.id }).from(tags).where(inArray(tags.id, tagIds)).all().map((t) => t.id));
    const missing = tagIds.filter((id) => !known.has(id));
    if (missing.length) throw httpError(400, `Unknown tag ids: ${missing.join(', ')}`, 'unknown_tag', { missing });
  }
  db.transaction((tx) => {
    tx.delete(comedianTags).where(eq(comedianTags.comedianId, comedian.id)).run();
    if (tagIds.length) {
      tx.insert(comedianTags)
        .values(tagIds.map((tagId) => ({ comedianId: comedian.id, tagId })))
        .run();
    }
  });
  return c.json(tagsByComedian(db, [comedian.id]).get(comedian.id) ?? []);
});

comediansRoutes.get(
  '/comedians/:id/availability',
  requireBooker,
  validate('query', comedianAvailabilityQuerySchema),
  (c) => {
    const db = c.var.db;
    const comedian = findComedian(db, parseId(c.req.param('id')));
    const today = clubToday(db);
    const month = c.req.valid('query').month ?? planningMonth(today);
    const from = firstDayOfMonth(month);
    const to = lastDayOfMonth(month);

    const entries = db
      .select({ date: availability.date, startMin: availability.startMin, endMin: availability.endMin })
      .from(availability)
      .where(and(eq(availability.comedianId, comedian.id), gte(availability.date, from), lte(availability.date, to)))
      .orderBy(asc(availability.date))
      .all();
    const submission = db
      .select({ submittedAt: availabilitySubmissions.submittedAt })
      .from(availabilitySubmissions)
      .where(and(eq(availabilitySubmissions.comedianId, comedian.id), eq(availabilitySubmissions.month, month)))
      .get();
    const monthBookings = selectBookings(
      db,
      and(
        eq(bookings.comedianId, comedian.id),
        gte(shows.date, from),
        lte(shows.date, to),
        eq(shows.status, 'scheduled'),
      ),
      'asc',
    );

    const body: ComedianAvailability = {
      month,
      entries,
      submittedAt: submission?.submittedAt ?? null,
      allNight: getAllNightRange(getSettings(db)),
      bookings: monthBookings,
      today,
    };
    return c.json(body);
  },
);

comediansRoutes.get('/comedians/:id/bookings', requireBooker, validate('query', comedianBookingsQuerySchema), (c) => {
  const db = c.var.db;
  const comedian = findComedian(db, parseId(c.req.param('id')));
  const { upcoming } = c.req.valid('query');
  const list = upcoming
    ? selectBookings(
        db,
        and(eq(bookings.comedianId, comedian.id), gte(shows.date, clubNight(db)), eq(shows.status, 'scheduled')),
        'asc',
      )
    : selectBookings(db, eq(bookings.comedianId, comedian.id), 'desc');
  return c.json(list);
});

comediansRoutes.get('/comedians/:id/card', requireBooker, (c) => {
  const db = c.var.db;
  const booker = c.var.booker;
  const comedian = findComedian(db, parseId(c.req.param('id')));
  const latest = selectNotes(db, eq(notes.comedianId, comedian.id), CARD_NOTE_COUNT);
  const noteCount = db.select({ n: count() }).from(notes).where(eq(notes.comedianId, comedian.id)).get()?.n ?? 0;
  const card: ComedianCard = {
    id: comedian.id,
    name: comedian.name,
    email: comedian.email,
    phone: comedian.phone,
    bio: comedian.bio,
    headshotUrl: comedian.headshotUrl,
    archived: comedian.archived,
    tags: tagsByComedian(db, [comedian.id]).get(comedian.id) ?? [],
    notes: latest.map((n) => withCanEdit(booker, n)),
    noteCount,
  };
  return c.json(card);
});

comediansRoutes.post('/comedians/:id/send-login-link', requireBooker, async (c) => {
  const db = c.var.db;
  const comedian = findComedian(db, parseId(c.req.param('id')));
  if (comedian.archived) {
    throw httpError(409, `${comedian.name} is archived. Restore them first.`, 'archived');
  }
  const body: SendLoginLinkResponse = { ok: true, ...(await sendLoginLink(db, comedian)) };
  return c.json(body);
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

comediansRoutes.get('/comedians/:id/notes', requireBooker, (c) => {
  const db = c.var.db;
  const booker = c.var.booker;
  const comedian = findComedian(db, parseId(c.req.param('id')));
  return c.json(selectNotes(db, eq(notes.comedianId, comedian.id)).map((n) => withCanEdit(booker, n)));
});

comediansRoutes.post('/comedians/:id/notes', requireBooker, validate('json', noteBodySchema), (c) => {
  const db = c.var.db;
  const booker = c.var.booker;
  const comedian = findComedian(db, parseId(c.req.param('id')));
  const { id } = db
    .insert(notes)
    .values({ comedianId: comedian.id, authorId: booker.id, body: c.req.valid('json').body })
    .returning({ id: notes.id })
    .get();
  return c.json(withCanEdit(booker, findNote(db, id)), 201);
});

comediansRoutes.patch('/notes/:id', requireBooker, validate('json', noteBodySchema), (c) => {
  const db = c.var.db;
  const booker = c.var.booker;
  const note = findNote(db, parseId(c.req.param('id')));
  if (!canEditNote(booker, note)) throw httpError(403, 'Only the author or an admin can edit this note', 'forbidden');
  db.update(notes).set({ body: c.req.valid('json').body }).where(eq(notes.id, note.id)).run();
  return c.json(withCanEdit(booker, findNote(db, note.id)));
});

comediansRoutes.delete('/notes/:id', requireBooker, (c) => {
  const db = c.var.db;
  const booker = c.var.booker;
  const note = findNote(db, parseId(c.req.param('id')));
  if (!canEditNote(booker, note)) throw httpError(403, 'Only the author or an admin can delete this note', 'forbidden');
  db.delete(notes).where(eq(notes.id, note.id)).run();
  return c.json({ ok: true as const });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

comediansRoutes.get('/tags', requireBooker, (c) => c.json(tagWithCount(c.var.db)));

comediansRoutes.post('/tags', requireBooker, validate('json', createTagSchema), (c) => {
  const db = c.var.db;
  const { name, color } = c.req.valid('json');
  assertTagNameFree(db, name);
  const used = db.select({ color: tags.color }).from(tags).all().map((t) => t.color);
  const { id } = db
    .insert(tags)
    .values({ name, color: color ?? nextTagColor(used) })
    .returning({ id: tags.id })
    .get();
  return c.json(findTag(db, id), 201);
});

comediansRoutes.patch('/tags/:id', requireBooker, validate('json', updateTagSchema), (c) => {
  const db = c.var.db;
  const tag = findTag(db, parseId(c.req.param('id')));
  const patch = c.req.valid('json');
  if (Object.keys(patch).length === 0) throw httpError(400, 'Nothing to update', 'validation_error');
  if (patch.name !== undefined) assertTagNameFree(db, patch.name, tag.id);
  db.update(tags).set(patch).where(eq(tags.id, tag.id)).run();
  return c.json(findTag(db, tag.id));
});

comediansRoutes.delete('/tags/:id', requireBooker, (c) => {
  const db = c.var.db;
  const tag = findTag(db, parseId(c.req.param('id')));
  db.transaction((tx) => {
    tx.delete(comedianTags).where(eq(comedianTags.tagId, tag.id)).run();
    tx.delete(tags).where(eq(tags.id, tag.id)).run();
  });
  return c.json({ ok: true as const });
});
