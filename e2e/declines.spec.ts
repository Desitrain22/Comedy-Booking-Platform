/**
 * Owner decision "declines" end to end (desktop; needs a freshly seeded database —
 * `npm run e2e` provides one):
 *
 *   the booker turns on "Let comedians decline individual spots" → a comedian opens the
 *   emailed "Can't make it?" link (`?decline=<booking>`), which only opens the form, and
 *   declines with a note → the booker sees it under "Needs a replacement", opens the day
 *   board, where the spot is struck through as Declined, and replaces it from the pool →
 *   turning declines off again leaves no decline UI (board legend, confirm page).
 *
 * It works two weeks out so it doesn't touch the weeks the other specs use, and always
 * switches declines back off (the seed default) for the specs that run after it.
 */
import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { addDays, formatTime, todayInTz, weekStartOf } from '../shared/time';

const DB_FILE = path.resolve(process.env.E2E_DATA_DIR ?? '.data/e2e', 'club.db');
const CLUB_TZ = 'America/New_York'; // the seeded club
const ADMIN = { email: 'admin@example.com', password: 'comedy123' };
const NOTE = 'My flight got moved';

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_FILE);
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function signInAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

/** Settings → Confirmations → "Let comedians decline individual spots", saved. */
async function setDeclines(page: Page, on: boolean) {
  await page.goto('/app/settings/confirmations');
  const toggle = page.getByRole('switch', { name: 'Let comedians decline individual spots' });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) {
    await toggle.click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Confirmation settings saved' })).toBeVisible();
  }
  const saved = withDb((db) => (db.prepare('SELECT allow_declines AS v FROM settings').get() as { v: number }).v);
  expect(saved).toBe(on ? 1 : 0);
}

interface Spot {
  bookingId: number;
  comedianId: number;
  name: string;
  date: string;
  startMin: number;
  showName: string;
  position: number;
}

/** A spot two weeks out (Mon–Sun), booking one on a scheduled show if the seed has none. */
function spotTwoWeeksOut(weekStart: string): Spot {
  const weekEnd = addDays(weekStart, 6);
  const select = `SELECT b.id AS bookingId, c.id AS comedianId, c.name, s.date, s.start_min AS startMin,
                         s.name AS showName, b.position
                  FROM bookings b JOIN shows s ON s.id = b.show_id JOIN comedians c ON c.id = b.comedian_id
                  WHERE s.date BETWEEN ? AND ? AND s.status = 'scheduled' AND c.archived = 0
                    AND b.declined_at IS NULL AND c.email != 'keisha@example.com'
                  ORDER BY s.date, s.start_min, b.position LIMIT 1`;
  return withDb((db) => {
    const found = db.prepare(select).get(weekStart, weekEnd) as Spot | undefined;
    if (found) return found;
    const show = db
      .prepare(`SELECT id FROM shows WHERE date BETWEEN ? AND ? AND status = 'scheduled' ORDER BY date, start_min LIMIT 1`)
      .get(weekStart, weekEnd) as { id: number } | undefined;
    expect(show, `a scheduled show between ${weekStart} and ${weekEnd} in the seed`).toBeTruthy();
    const comedian = db
      .prepare(`SELECT id FROM comedians WHERE archived = 0 AND email != 'keisha@example.com' ORDER BY id LIMIT 1`)
      .get() as { id: number };
    db.prepare(
      `INSERT INTO bookings (show_id, comedian_id, position, override_unavailable, confirmation_sent_at, created_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM bookings WHERE show_id = ?), 1, ?, ?)`,
    ).run(show!.id, comedian.id, show!.id, Date.now(), Date.now());
    return db.prepare(select).get(weekStart, weekEnd) as Spot;
  });
}

/** The emailed confirm link's token for that comedian and week. */
function confirmToken(comedianId: number, weekStart: string): string {
  const token = randomBytes(32).toString('base64url');
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO tokens (token_hash, comedian_id, purpose, week_start, expires_at, created_at)
         VALUES (?, ?, 'confirm', ?, ?, ?)`,
      )
      .run(createHash('sha256').update(token).digest('hex'), comedianId, weekStart, Date.now() + 7 * 86_400_000, Date.now()),
  );
  return token;
}

test.afterAll(() => {
  // Whatever happened above, leave the club as seeded (declines off) for the next specs.
  withDb((db) => db.prepare('UPDATE settings SET allow_declines = 0').run());
});

test('declines on: a comedian declines one spot from the email link, the booker replaces it; off: no decline UI', async ({
  page,
  browser,
}) => {
  const weekStart = addDays(weekStartOf(todayInTz(CLUB_TZ)), 14);
  const spot = spotTwoWeeksOut(weekStart);
  const firstName = spot.name.split(' ')[0]!;
  const showTitle = `${formatTime(spot.startMin)} ${spot.showName || 'show'}`;
  const declinedRow = () =>
    withDb(
      (db) =>
        db.prepare('SELECT declined_at AS declinedAt, decline_note AS note FROM bookings WHERE id = ?').get(spot.bookingId) as
          | { declinedAt: number | null; note: string }
          | undefined,
    );

  // 1. The booker allows declines ----------------------------------------------------------
  await signInAsAdmin(page);
  await setDeclines(page, true);

  // 2. The comedian follows the email's "Can't make it?" link: it only opens the form -------
  const token = confirmToken(spot.comedianId, weekStart);
  const comedianContext = await browser.newContext();
  const comedian = await comedianContext.newPage();
  await comedian.goto(`/portal/confirm/${token}?decline=${spot.bookingId}`);
  await expect(comedian.getByRole('heading', { name: new RegExp(`Hey ${firstName}, you're booked`) })).toBeVisible();
  const form = comedian.getByRole('form', { name: /^Can't make / });
  await expect(form).toBeVisible();
  expect(declinedRow()?.declinedAt).toBeNull(); // opening the link (or a mail scanner) changes nothing
  await form.getByRole('textbox').fill(NOTE);
  await form.getByRole('button', { name: /I can't make it/ }).click();
  await expect(comedian.locator('[data-sonner-toast]').filter({ hasText: /the club knows you can.t make it/ })).toBeVisible();
  await expect(comedian.getByRole('button', { name: /^Undo — I can make / })).toBeVisible();
  expect(declinedRow()).toMatchObject({ note: NOTE });
  expect(declinedRow()?.declinedAt).not.toBeNull();

  // 3. The booker: "Needs a replacement" on the dashboard → the day board -------------------
  await page.goto('/app');
  const needs = page.getByRole('region', { name: /Needs a replacement/ });
  await expect(needs).toContainText(spot.name);
  await expect(needs).toContainText(`“${NOTE}”`);
  await needs.getByRole('link', { name: new RegExp(`^Find a replacement for ${spot.name}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/app/day/${spot.date}$`));
  await expect(page.getByRole('list', { name: 'Legend' })).toContainText('Declined');

  const lineup = page.getByRole('list', { name: `${showTitle} lineup` });
  const slot = spot.position + 1;
  const declinedChip = lineup.getByRole('button', { name: new RegExp(`^Slot ${slot}: ${spot.name}, Declined`) });
  await expect(declinedChip).toBeVisible();
  await expect(declinedChip).toHaveAttribute('title', new RegExp(`can’t make it: “${NOTE}”`));

  // Click the declined chip (selects its slot), then a pool comedian: they replace it.
  const { id: replacementId, name: replacement } = withDb(
    (db) =>
      db
        .prepare(
          `SELECT c.id, c.name FROM comedians c WHERE c.archived = 0 AND c.email != 'keisha@example.com' AND c.id NOT IN (
             SELECT b.comedian_id FROM bookings b JOIN shows s ON s.id = b.show_id WHERE s.date = ?
           ) ORDER BY c.name LIMIT 1`,
        )
        .get(spot.date) as { id: number; name: string },
  );
  await declinedChip.click({ position: { x: 12, y: 10 } }); // the name, not the notes badge
  const pool = page.getByRole('complementary', { name: 'Comedians' });
  await pool.getByLabel('Search comedians').fill(replacement);
  await pool.getByRole('button', { name: new RegExp(`^${replacement}\\.`) }).click();
  const ask = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'isn’t available' });
  const replaced = lineup.getByRole('button', { name: new RegExp(`^Slot ${slot}: ${replacement}, Not sent`) });
  await expect(replaced.or(ask)).toBeVisible();
  if (await ask.isVisible()) await ask.getByRole('button', { name: 'Book anyway' }).click();
  await expect(replaced).toBeVisible();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Replaced ${spot.name} with ${replacement}` })).toBeVisible();
  expect(declinedRow()).toBeUndefined(); // the declined booking is gone (Undo would bring it back)

  // 4. Declines off: no decline UI anywhere -------------------------------------------------
  await setDeclines(page, false);
  await page.goto(`/app/day/${spot.date}`);
  await expect(page.getByRole('list', { name: 'Legend' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Legend' })).not.toContainText('Declined');
  // The replacement's own confirm link (even a stale ?decline= one): spots, but no decline UI.
  const newBookingId = withDb(
    (db) =>
      (
        db
          .prepare('SELECT b.id FROM bookings b JOIN shows s ON s.id = b.show_id WHERE b.comedian_id = ? AND s.date = ?')
          .get(replacementId, spot.date) as { id: number }
      ).id,
  );
  await comedian.goto(`/portal/confirm/${confirmToken(replacementId, weekStart)}?decline=${newBookingId}`);
  await expect(
    comedian.getByRole('heading', { name: new RegExp(`Hey ${replacement.split(' ')[0]}, you're booked`) }),
  ).toBeVisible();
  await expect(comedian.getByRole('button', { name: /Confirm my spot/ })).toBeVisible();
  await expect(comedian.getByRole('button', { name: /^Can't make / })).toHaveCount(0);
  await expect(comedian.getByRole('form', { name: /^Can't make / })).toHaveCount(0);
  await comedianContext.close();
});
