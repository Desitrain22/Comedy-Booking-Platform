/**
 * F4 comedian portal e2e (runs in the desktop AND the mobile/touch project).
 *
 * - Availability: sign in with an emailed code, paint 9–11 PM on every Saturday via the
 *   weekday button, drag-paint "All night" across a week (a real finger drag on mobile,
 *   which must paint, not scroll), erase a night, Save, reload → it persisted.
 * - Confirm link: loading it changes nothing; "Confirm my spots" confirms + signs in.
 * - Back/Forward with unsaved changes asks Save / Keep editing / Discard, like a link click.
 */
import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { addDays, addMonths, datesForWeekday, monthGrid, monthOf, todayInTz, weekStartOf } from '../shared/time';

const DB_FILE = path.resolve(process.env.E2E_DATA_DIR ?? '.data/e2e', 'club.db');
const CLUB_TZ = 'America/New_York'; // the seeded club

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_FILE);
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function latestCode(email: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(() => {
      const row = withDb((db) =>
        db
          .prepare(`SELECT body_text FROM email_log WHERE to_email = ? AND kind = 'login_code' ORDER BY id DESC LIMIT 1`)
          .get(email),
      ) as { body_text: string } | undefined;
      code = row && /\b(\d{6})\b/.exec(row.body_text)?.[1];
      return code;
    })
    .toBeTruthy();
  return code!;
}

async function signInWithCode(page: Page, email: string) {
  await expect(page).toHaveURL(/\/portal\/login\?next=/);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByLabel('6-digit code').fill(await latestCode(email)); // submits at 6 digits
}

/** Insert a sign-in link token (what an availability-request email contains). */
function createMagicToken(comedianEmail: string, redirectTo: string): string {
  const token = randomBytes(32).toString('base64url');
  withDb((db) => {
    const comedian = db.prepare('SELECT id FROM comedians WHERE email = ?').get(comedianEmail) as { id: number };
    const now = Date.now();
    db.prepare(
      `INSERT INTO tokens (token_hash, comedian_id, purpose, redirect_to, expires_at, created_at)
       VALUES (?, ?, 'login', ?, ?, ?)`,
    ).run(createHash('sha256').update(token).digest('hex'), comedian.id, redirectTo, now + 86_400_000, now);
  });
  return token;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

test('paint every Saturday 9–11 PM, drag-paint, erase, save, and it persists', async ({ page, context }, testInfo) => {
  const touch = testInfo.project.name === 'mobile';
  const email = touch ? 'jason@example.com' : 'maria@example.com';
  const month = addMonths(monthOf(todayInTz(CLUB_TZ)), 1); // no past days
  const saturdays = datesForWeekday(month, 6);
  const week = monthGrid(month)[1]!; // the 2nd row is always a full Sun–Sat week
  const [mon, tue, wed] = [week[1]!, week[2]!, week[3]!];
  const cell = (date: string) => page.locator(`[data-date="${date}"]`);
  const status = page.getByTestId('availability-status');

  await page.goto(`/portal?month=${month}`);
  await signInWithCode(page, email);
  await expect(page).toHaveURL(new RegExp(`/portal\\?month=${month}$`));

  // Start from a blank month (the seed may have marked some nights).
  await page.getByRole('button', { name: 'Not available' }).click();
  for (const day of WEEKDAYS) await page.getByRole('button', { name: `Clear every ${day}` }).click();

  // 9–11 PM on every Saturday.
  await page.getByLabel('Free from').selectOption('1260');
  await page.getByLabel('Free until').selectOption('1380');
  await page.getByRole('button', { name: 'Mark every Saturday' }).click();
  for (const date of saturdays) {
    await expect(cell(date)).toContainText('9–11 PM');
    await expect(cell(date)).toHaveAttribute('aria-selected', 'true');
  }

  // Drag "All night" across Mon → Wed of the second week.
  await page.getByRole('button', { name: /^All night/ }).click();
  await cell(mon).scrollIntoViewIfNeeded();
  const a = (await cell(mon).boundingBox())!;
  const b = (await cell(wed).boundingBox())!;
  const scrollBefore = await page.evaluate<number>('window.scrollY');
  if (touch) {
    const cdp = await context.newCDPSession(page);
    const point = (x: number, y: number) => ({ touchPoints: [{ x, y }] });
    const y = a.y + a.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', ...point(a.x + a.width / 2, y) });
    for (const t of [0.25, 0.5, 0.75, 1]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        ...point(a.x + a.width / 2 + (b.x - a.x) * t, y + 6 * t),
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
  }
  for (const date of [mon, tue, wed]) await expect(cell(date)).toContainText('All night');
  expect(await page.evaluate<number>('window.scrollY')).toBe(scrollBefore); // painted, didn't scroll

  // "Not available" erases.
  await page.getByRole('button', { name: 'Not available' }).click();
  await cell(tue).click();
  await expect(cell(tue)).not.toContainText('All night');

  const marked = saturdays.length + 2;
  await expect(status).toContainText(`Unsaved changes · ${marked} nights marked`);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved — the club can see it now')).toBeVisible();
  await expect(status).toContainText(`Saved · ${marked} nights marked`);

  await page.reload();
  for (const date of saturdays) await expect(cell(date)).toContainText('9–11 PM');
  await expect(cell(mon)).toContainText('All night');
  await expect(cell(wed)).toContainText('All night');
  await expect(cell(tue)).toHaveAttribute('aria-selected', 'false');
  await expect(status).toContainText(`Saved · ${marked} nights marked`);
});

test('a confirm link is read-only until "Confirm my spots"', async ({ page }) => {
  const nextWeek = addDays(weekStartOf(todayInTz(CLUB_TZ)), 7);
  // A comedian with an unconfirmed spot next week (each project run takes the next one).
  const target = withDb(
    (db) =>
      db
        .prepare(
          `SELECT c.id, c.name FROM bookings b JOIN shows s ON s.id = b.show_id JOIN comedians c ON c.id = b.comedian_id
           WHERE s.date BETWEEN ? AND ? AND s.status = 'scheduled' AND b.confirmed_at IS NULL AND c.archived = 0
           ORDER BY c.id LIMIT 1`,
        )
        .get(nextWeek, addDays(nextWeek, 6)) as { id: number; name: string } | undefined,
  );
  test.skip(!target, 'no unconfirmed spots next week in the seed');
  const unconfirmed = () =>
    withDb(
      (db) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM bookings b JOIN shows s ON s.id = b.show_id
               WHERE b.comedian_id = ? AND s.date BETWEEN ? AND ? AND s.status = 'scheduled' AND b.confirmed_at IS NULL`,
            )
            .get(target!.id, nextWeek, addDays(nextWeek, 6)) as { n: number }
        ).n,
    );
  const token = randomBytes(32).toString('base64url');
  withDb((db) =>
    db
      .prepare(
        `INSERT INTO tokens (token_hash, comedian_id, purpose, week_start, expires_at, created_at)
         VALUES (?, ?, 'confirm', ?, ?, ?)`,
      )
      .run(createHash('sha256').update(token).digest('hex'), target!.id, nextWeek, Date.now() + 7 * 86_400_000, Date.now()),
  );
  const before = unconfirmed();
  expect(before).toBeGreaterThan(0);

  await page.goto(`/portal/confirm/${token}`);
  const firstName = target!.name.split(' ')[0]!;
  await expect(page.getByRole('heading', { name: new RegExp(`Hey ${firstName}, you're booked`) })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Portal' })).toHaveCount(0); // not signed in
  expect(unconfirmed()).toBe(before); // viewing changed nothing

  await page.getByRole('button', { name: /Confirm my spot/ }).click();
  await expect(page.getByRole('heading', { name: "You're confirmed!" })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Portal' })).toBeVisible(); // signed in now
  expect(unconfirmed()).toBe(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: "You're already confirmed" })).toBeVisible();
});

test('Back/Forward with unsaved changes asks first: keep editing, then discard', async ({ page }, testInfo) => {
  const email = testInfo.project.name === 'mobile' ? 'devon@example.com' : 'priya@example.com';
  await page.goto(`/portal/magic/${createMagicToken(email, '/portal/spots')}`);
  await expect(page).toHaveURL(/\/portal\/spots$/);

  // In-app history: My spots → Availability → next month.
  await page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Availability' }).click();
  const status = page.getByTestId('availability-status');
  await expect(status).toBeVisible();
  const start = page.url();
  await page.getByRole('button', { name: /^Next month/ }).click();
  await expect(page).not.toHaveURL(start);
  await expect(status).toBeVisible();
  const editing = page.url();

  // An unsaved change (a range nobody in the seed uses).
  await page.getByLabel('Free from').selectOption('990');
  await page.getByLabel('Free until').selectOption('1050');
  await page.getByRole('button', { name: 'Mark every Saturday' }).click();
  await expect(status).toContainText('Unsaved changes');

  const dialog = page.getByRole('dialog', { name: 'Save your availability?' });
  await page.evaluate('history.back()');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(editing);
  await expect(status).toContainText('Unsaved changes');

  await page.evaluate('history.back()');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(start);

  // Forward again: nothing unsaved now, so no question — and the change was discarded.
  await page.evaluate('history.forward()');
  await expect(page).toHaveURL(editing);
  await expect(status).not.toContainText('Unsaved changes');
  await expect(dialog).toBeHidden();

  // Back again with a change: Save keeps it, then goes.
  await page.getByRole('button', { name: 'Mark every Saturday' }).click();
  await expect(status).toContainText('Unsaved changes');
  await page.evaluate('history.back()');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(start);

  // Forward with unsaved changes (on the first month) asks too.
  await page.getByRole('button', { name: 'Mark every Saturday' }).click();
  await expect(status).toContainText('Unsaved changes');
  await page.evaluate('history.forward()');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(editing);
  await expect(status).toContainText('Saved'); // what Save stored above
});
