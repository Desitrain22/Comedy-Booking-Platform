/**
 * `npm run seed` — wipe the database in $DATA_DIR and fill it with demo data relative to
 * *today in the club timezone*, so the dashboard always has something to show:
 * shows for the current and next month, availability for ~70% of comedians, bookings for
 * this week and next (confirmed / awaiting / not sent), today's unconfirmed spots,
 * a few "booked anyway" overrides, notes and availability requests.
 *
 * Deterministic for a given date (seeded PRNG). Safe to run while the server is running.
 */
import { sql } from 'drizzle-orm';
import { isAvailableFor, type AvailabilityRange } from '../../shared/availability';
import {
  addDays,
  addMonths,
  daysInMonth,
  monthOf,
  todayInTz,
  weekStartOf,
  weekdayOf,
  zonedTimeToUtc,
} from '../../shared/time';
import { hashPassword } from '../auth/password';
import { env } from '../env';
import { closeDb, createDb, type Tx } from './client';
import * as t from './schema';

const CLUB = 'The Laugh Track';
const TZ = 'America/New_York';
const PASSWORD = 'comedy123';
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261028);
const chance = (p: number) => rand() < p;
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Demo content
// ---------------------------------------------------------------------------

const COMEDIANS: ReadonlyArray<readonly [first: string, last: string]> = [
  ['John', 'Mercer'], ['Jason', 'Park'], ['Maria', 'Delgado'], ['Priya', 'Raman'],
  ['Devon', 'Hayes'], ['Sam', 'Kowalski'], ['Keisha', 'Grant'], ['Marcus', 'Bell'],
  ['Lena', 'Novak'], ['Omar', 'Haddad'], ['Tara', 'Quinlan'], ['Ben', 'Okafor'],
  ['Chloe', 'Tran'], ['Rafael', 'Ortiz'], ['Nina', 'Volkova'], ['Gus', 'Lindqvist'],
  ['Hannah', 'Brooks'], ['Ivan', 'Petrov'], ['Jade', 'Morrison'], ['Kofi', 'Mensah'],
  ['Lucy', 'Fairweather'], ['Mateo', 'Ruiz'], ['Noor', 'Siddiqui'], ['Owen', 'Gallagher'],
  ['Paige', 'Whitman'], ['Quinn', 'Albright'], ['Rosa', 'Esposito'], ['Theo', 'Lambert'],
  ['Uma', 'Patel'], ['Wes', 'Calloway'],
];
const ARCHIVED = new Set(['Wes']);
const WITH_HEADSHOT = new Set(['John', 'Priya', 'Marcus', 'Lena', 'Kofi']);

const TAGS = [
  { name: 'Hosts', color: '#3b82f6', members: ['John', 'Maria', 'Devon', 'Keisha'] },
  { name: 'Headliners', color: '#e5484d', members: ['Jason', 'Priya', 'Marcus', 'Omar', 'Lena'] },
  {
    name: 'All Stars',
    color: '#d946ef',
    members: ['Jason', 'Priya', 'Marcus', 'Omar', 'Lena', 'Tara', 'Ben', 'Chloe'],
  },
  {
    name: 'Bullet Spots',
    color: '#14b8a6',
    members: ['Hannah', 'Ivan', 'Jade', 'Kofi', 'Lucy', 'Mateo', 'Noor', 'Owen', 'Paige'],
  },
] as const;

const CREDITS = [
  'Comedy Central Up Next',
  'the Just For Laughs New Faces showcase',
  'a Netflix half-hour',
  'Late Night with Seth Meyers',
  'the Moth GrandSLAM',
  'a sold-out Edinburgh run',
  'Kill Tony',
  'the Montreal Comedy Festival',
];
const STYLES = [
  'storytelling about growing up with five siblings',
  'dry one-liners',
  'crowd work that never goes off the rails',
  'act-outs about working retail',
  'observational bits about dating apps',
  'political satire that somehow keeps both sides laughing',
  'musical comedy with a busted ukulele',
];

const NOTE_BODIES = [
  'Killed at the 9 PM on Saturday. Book for more prime spots.',
  'Prefers early shows (day job). Avoid anything after 10.',
  'Ran long: 12 minutes on a 7. Reminded about the light.',
  'Great host energy. Ask about New Year’s Eve.',
  'Brings a crowd: six friends at the last show.',
  'Material is getting edgier; keep off the Sunday showcase for now.',
  'Bullet spots only until we see a tighter five.',
  'Asked for a Friday 9 PM. Give one next month if possible.',
  'Very reliable, always confirms the same day.',
  'Headlining out of town the first week of next month.',
  'Strong new closer about the subway. Worth a longer spot.',
  'Canceled last minute twice this year. Confirm a day early.',
];

interface ShowTemplate {
  location: 'cellar' | 'annex';
  startMin: number;
  name: string;
  slotCount: number;
}

/** Weekly pattern by weekday (0 = Sun). Mon/Tue are dark. */
const SHOW_PATTERN: Record<number, ShowTemplate[]> = {
  0: [{ location: 'cellar', startMin: 1140, name: 'Sunday Showcase', slotCount: 6 }],
  3: [
    { location: 'cellar', startMin: 1260, name: 'Midweek Standup', slotCount: 6 },
    { location: 'annex', startMin: 1200, name: 'Open Mic', slotCount: 10 },
  ],
  4: [{ location: 'cellar', startMin: 1200, name: 'Thursday Showcase', slotCount: 6 }],
  5: [
    { location: 'cellar', startMin: 1140, name: 'Early Show', slotCount: 6 },
    { location: 'cellar', startMin: 1170, name: 'Dinner Show', slotCount: 5 },
    { location: 'cellar', startMin: 1260, name: 'Main Event', slotCount: 7 },
    { location: 'cellar', startMin: 1380, name: 'Late Show', slotCount: 6 },
    { location: 'annex', startMin: 1080, name: 'Happy Hour', slotCount: 5 },
    { location: 'annex', startMin: 1200, name: 'Annex Showcase', slotCount: 6 },
    { location: 'annex', startMin: 1320, name: 'Annex Late', slotCount: 5 },
  ],
};
SHOW_PATTERN[6] = SHOW_PATTERN[5]!;

/** Shows added on today when today would otherwise be dark (so the dashboard has data). */
const DARK_DAY_SHOWS: ShowTemplate[] = [
  { location: 'cellar', startMin: 1200, name: 'Industry Night', slotCount: 6 },
  { location: 'annex', startMin: 1260, name: 'New Material Night', slotCount: 6 },
];

const RANGES: ReadonlyArray<readonly [weight: number, range: AvailabilityRange]> = [
  [0.45, { startMin: 1140, endMin: 1380 }], // all night 7–11 PM
  [0.2, { startMin: 1260, endMin: 1440 }], // 9 PM–12 AM
  [0.15, { startMin: 1140, endMin: 1260 }], // 7–9 PM
  [0.1, { startMin: 1320, endMin: 1500 }], // 10 PM–1 AM
  [0.1, { startMin: 1080, endMin: 1320 }], // 6–10 PM
];
const NIGHT_PROBABILITY = [0.4, 0.15, 0.15, 0.5, 0.5, 0.7, 0.7]; // by weekday

function pickRange(): AvailabilityRange {
  let r = rand();
  for (const [weight, range] of RANGES) {
    if ((r -= weight) <= 0) return range;
  }
  return RANGES[0]![1];
}

// ---------------------------------------------------------------------------

/** Delete everything, children before parents, and reset autoincrement counters. */
function wipe(tx: Tx) {
  const tables = [
    t.bookings, t.availability, t.availabilitySubmissions, t.availabilityRequests, t.comedianTags,
    t.notes, t.emailLog, t.loginCodes, t.tokens, t.sessions, t.shows, t.locations, t.tags,
    t.comedians, t.users, t.jobRuns, t.settings,
  ];
  for (const table of tables) tx.delete(table).run();
  tx.run(sql`DELETE FROM sqlite_sequence`);
}

function defaultAppUrl(): string {
  if (env.appUrl) return env.appUrl;
  if (env.isProduction) return `http://localhost:${env.port}`;
  return `http://localhost:${process.env.VITE_PORT || 5173}`;
}

interface SeedSummary {
  today: string;
  shows: number;
  bookings: number;
  unconfirmedToday: number;
  overrides: number;
  comedians: number;
}

function seed(tx: Tx, passwordHash: string, now: number): SeedSummary {
  const today = todayInTz(TZ, new Date(now));
  const thisMonth = monthOf(today);
  const nextMonth = addMonths(thisMonth, 1);
  const thisWeek = weekStartOf(today);

  // Settings ------------------------------------------------------------------
  tx.insert(t.settings)
    .values({ id: 1, clubName: CLUB, timezone: TZ, appUrl: defaultAppUrl(), setupComplete: true, createdAt: now - 120 * DAY })
    .run();

  // Bookers ---------------------------------------------------------------------
  const admin = tx
    .insert(t.users)
    .values({ email: 'admin@example.com', name: 'Dana Whitfield', role: 'admin', passwordHash, createdAt: now - 120 * DAY })
    .returning()
    .get();
  const booker = tx
    .insert(t.users)
    .values({ email: 'booker@example.com', name: 'Marco Bellini', role: 'booker', passwordHash, createdAt: now - 90 * DAY })
    .returning()
    .get();
  const bookerIds = [admin.id, booker.id];

  // Locations -------------------------------------------------------------------
  const cellar = tx
    .insert(t.locations)
    .values({ name: 'The Cellar', address: '214 Sullivan St, New York, NY', color: '#7c5cff', sortOrder: 0 })
    .returning()
    .get();
  const annex = tx
    .insert(t.locations)
    .values({ name: 'The Annex', address: '216 Sullivan St, New York, NY', color: '#f08c2e', sortOrder: 1 })
    .returning()
    .get();
  const locationIds = { cellar: cellar.id, annex: annex.id };

  // Comedians -------------------------------------------------------------------
  const comedians = COMEDIANS.map(([first, last], i) => {
    const years = 2 + Math.floor(rand() * 14);
    return tx
      .insert(t.comedians)
      .values({
        email: `${first.toLowerCase()}@example.com`,
        name: `${first} ${last}`,
        bio: `${first} has been doing stand-up for ${years} years, known for ${pick(STYLES)}. Credits include ${pick(CREDITS)}.`,
        headshotUrl: WITH_HEADSHOT.has(first) ? `https://i.pravatar.cc/300?u=${first.toLowerCase()}` : '',
        archived: ARCHIVED.has(first),
        createdAt: now - (200 - i * 5) * DAY,
        updatedAt: now - (30 - (i % 30)) * DAY,
      })
      .returning()
      .get();
  });
  const byFirst = new Map(comedians.map((c) => [c.name.split(' ')[0]!, c]));
  const active = comedians.filter((c) => !c.archived);

  // Tags ------------------------------------------------------------------------
  for (const tag of TAGS) {
    const row = tx.insert(t.tags).values({ name: tag.name, color: tag.color }).returning().get();
    for (const first of tag.members) {
      tx.insert(t.comedianTags).values({ comedianId: byFirst.get(first)!.id, tagId: row.id }).run();
    }
  }
  const hostIds = new Set(TAGS[0].members.map((f) => byFirst.get(f)!.id));

  // Availability ----------------------------------------------------------------
  // ~70% submitted: most for both months, a few only this month; one submitted "nothing".
  const availability = new Map<number, Map<string, AvailabilityRange>>();
  const submittedOnlyThisMonth = new Set(['Rafael', 'Nina', 'Theo']);
  const neverSubmitted = new Set(['Sam', 'Tara', 'Quinn', 'Rosa', 'Uma', 'Owen', 'Chloe', 'Ivan']);
  const submittedNothing = 'Gus';
  for (const comedian of active) {
    const first = comedian.name.split(' ')[0]!;
    if (neverSubmitted.has(first)) continue;
    const months = submittedOnlyThisMonth.has(first) ? [thisMonth] : [thisMonth, nextMonth];
    const nights = new Map<string, AvailabilityRange>();
    for (const month of months) {
      tx.insert(t.availabilitySubmissions)
        .values({ comedianId: comedian.id, month, submittedAt: now - Math.floor(rand() * 20 + 1) * DAY })
        .run();
      if (first === submittedNothing) continue;
      for (const date of daysInMonth(month)) {
        // Most comedians are free today, so tonight's lineups (and unconfirmed spots) fill up.
        const p = date === today ? 0.85 : NIGHT_PROBABILITY[weekdayOf(date)]!;
        if (!chance(p)) continue;
        const range = pickRange();
        nights.set(date, range);
        tx.insert(t.availability).values({ comedianId: comedian.id, date, ...range }).run();
      }
    }
    availability.set(comedian.id, nights);
  }

  // Shows -----------------------------------------------------------------------
  const allShows: (t.Show & { locationKey: 'cellar' | 'annex' })[] = [];
  const dates = [...daysInMonth(thisMonth), ...daysInMonth(nextMonth)];
  const firstSundayNextMonth = daysInMonth(nextMonth).find((d) => weekdayOf(d) === 0);
  for (const date of dates) {
    let templates = SHOW_PATTERN[weekdayOf(date)] ?? [];
    if (date === today && templates.length === 0) templates = DARK_DAY_SHOWS;
    for (const tpl of templates) {
      const show = tx
        .insert(t.shows)
        .values({
          locationId: locationIds[tpl.location],
          date,
          startMin: tpl.startMin,
          name: tpl.name,
          slotCount: tpl.slotCount,
          status: date === firstSundayNextMonth ? 'cancelled' : 'scheduled',
          notes: tpl.name === 'Open Mic' ? 'Sign-up list opens at 7:30. Five minutes each.' : '',
          createdAt: now - 40 * DAY,
        })
        .returning()
        .get();
      allShows.push({ ...show, locationKey: tpl.location });
    }
  }

  // Bookings (this week + next) -------------------------------------------------
  const bookingWindowEnd = addDays(thisWeek, 13);
  const mondayConfirmations = zonedTimeToUtc(thisWeek, 600, TZ);
  const confirmationsSentAt = Math.min(mondayConfirmations, now - 2 * 3_600_000);
  const todayPattern = ['confirmed', 'awaiting', 'confirmed', 'not_sent'] as const;
  let todayIndex = 0;
  let overrides = 0;
  let bookingCount = 0;
  let unconfirmedToday = 0;
  const bookedOnDate = new Map<string, Set<number>>();

  const windowShows = allShows
    .filter((s) => s.status === 'scheduled' && s.date >= thisWeek && s.date <= bookingWindowEnd)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);

  for (const show of windowShows) {
    const taken = bookedOnDate.get(show.date) ?? new Set<number>();
    bookedOnDate.set(show.date, taken);
    const fill = Math.max(
      show.date === today ? 4 : 2,
      Math.round(show.slotCount * (show.date <= addDays(thisWeek, 6) ? 0.7 + rand() * 0.3 : 0.4 + rand() * 0.4)),
    );
    const free = shuffle(active.filter((c) => !taken.has(c.id)));
    const available = free.filter((c) => isAvailableFor(availability.get(c.id)?.get(show.date), show.startMin));
    // Put a host first when one is free.
    available.sort((a, b) => Number(hostIds.has(b.id)) - Number(hostIds.has(a.id)));
    const lineup: { comedianId: number; override: boolean }[] = available
      .slice(0, Math.min(fill, show.slotCount))
      .map((c) => ({ comedianId: c.id, override: false }));
    // "Booked anyway": a few unavailable comedians on busy nights.
    if (overrides < 4 && lineup.length < show.slotCount && (lineup.length < fill || chance(0.15))) {
      const unavailable = free.find((c) => !lineup.some((l) => l.comedianId === c.id) && !available.includes(c));
      if (unavailable) {
        lineup.push({ comedianId: unavailable.id, override: true });
        overrides++;
      }
    }
    // Leave the occasional hole mid-lineup so the board shows empty slots.
    const skip = lineup.length >= 3 && lineup.length < show.slotCount && chance(0.3) ? 2 : -1;

    lineup.forEach((entry, i) => {
      const position = skip >= 0 && i >= skip ? i + 1 : i;
      let confirmationSentAt: number | null = null;
      let confirmedAt: number | null = null;
      let confirmedBy: 'comedian' | 'booker' | null = null;

      if (show.date < today) {
        confirmationSentAt = confirmationsSentAt;
        confirmedAt = confirmationsSentAt + Math.floor(rand() * 20 + 1) * 3_600_000;
        confirmedBy = 'comedian';
      } else if (show.date === today) {
        const state = todayPattern[todayIndex++ % todayPattern.length]!;
        if (state !== 'not_sent') confirmationSentAt = confirmationsSentAt;
        if (state === 'confirmed') {
          confirmedAt = Math.min(now, confirmationsSentAt + 3 * 3_600_000);
          confirmedBy = 'comedian';
        } else unconfirmedToday++;
      } else if (show.date <= addDays(thisWeek, 6)) {
        confirmationSentAt = confirmationsSentAt;
        if (chance(0.55)) {
          confirmedAt = Math.min(now, confirmationsSentAt + Math.floor(rand() * 30 + 1) * 3_600_000);
          confirmedBy = 'comedian';
        }
      } else if (chance(0.15)) {
        confirmedAt = now - Math.floor(rand() * 48) * 3_600_000;
        confirmedBy = 'booker';
      }

      tx.insert(t.bookings)
        .values({
          showId: show.id,
          comedianId: entry.comedianId,
          position,
          overrideUnavailable: entry.override,
          bookedById: pick(bookerIds),
          confirmationSentAt,
          confirmedAt,
          confirmedBy,
          createdAt: now - Math.floor(rand() * 14 + 1) * DAY,
        })
        .run();
      taken.add(entry.comedianId);
      bookingCount++;
    });
  }
  if (confirmationsSentAt <= now) {
    tx.insert(t.jobRuns).values({ key: `confirmations:${thisWeek}`, ranAt: confirmationsSentAt }).run();
  }

  // Notes -------------------------------------------------------------------------
  NOTE_BODIES.forEach((body, i) => {
    const comedian = active[(i * 7) % active.length]!;
    const createdAt = now - Math.floor(rand() * 60 + 1) * DAY;
    tx.insert(t.notes)
      .values({ comedianId: comedian.id, authorId: bookerIds[i % 2]!, body, createdAt, updatedAt: createdAt })
      .run();
  });

  // Availability requests ---------------------------------------------------------
  const submittedNext = active.filter((c) => {
    const first = c.name.split(' ')[0]!;
    return !neverSubmitted.has(first) && !submittedOnlyThisMonth.has(first);
  }).length;
  tx.insert(t.availabilityRequests)
    .values([
      {
        month: thisMonth,
        kind: 'request',
        message: '',
        audience: 'all',
        recipientCount: active.length,
        sentById: admin.id,
        sentAt: zonedTimeToUtc(addDays(`${thisMonth}-01`, -12), 720, TZ),
      },
      {
        month: nextMonth,
        kind: 'request',
        message: 'Holiday shows are filling up fast. Get your dates in early!',
        audience: 'all',
        recipientCount: active.length,
        sentById: admin.id,
        sentAt: now - 6 * DAY,
      },
      {
        month: nextMonth,
        kind: 'reminder',
        message: '',
        audience: 'all',
        recipientCount: active.length - submittedNext,
        sentById: booker.id,
        sentAt: now - 1 * DAY,
      },
    ])
    .run();

  return {
    today,
    shows: allShows.length,
    bookings: bookingCount,
    unconfirmedToday,
    overrides,
    comedians: comedians.length,
  };
}

async function main() {
  const db = createDb(env.dbFile);
  const passwordHash = await hashPassword(PASSWORD);
  const now = Date.now();
  const summary = db.transaction((tx) => {
    wipe(tx);
    return seed(tx, passwordHash, now);
  });
  closeDb(db);

  console.log(`
Seeded "${CLUB}" (${TZ}). Today in the club is ${summary.today}.

  Bookers     admin@example.com  / ${PASSWORD}   (admin)
              booker@example.com / ${PASSWORD}   (booker)
  Comedians   john@example.com, jason@example.com, maria@example.com … (${summary.comedians} total)
              Sign in at /portal/login. With no SMTP configured the code is printed
              in the server console and listed under Settings → Email.

  Data        ${summary.shows} shows, ${summary.bookings} bookings (${summary.unconfirmedToday} unconfirmed today, ${summary.overrides} overrides)
  Database    ${env.dbFile}
`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
