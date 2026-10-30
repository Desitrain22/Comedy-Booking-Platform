/**
 * The club's monthly rhythm end to end, across every feature (desktop only; needs a freshly
 * seeded database — `npm run e2e` provides one):
 *
 *   booker creates next month's shows (weekday chip) → requests availability from a tag →
 *   the comedian opens the emailed sign-in link, paints every Saturday 9–11 PM and saves →
 *   the booker sees them available on a Saturday's day board and drags them into a slot,
 *   then books an unavailable comedian anyway → sends this week's confirmations → a comedian
 *   opens their confirm link (viewing changes nothing) and confirms → the booker sees it on
 *   the dashboard and day board, and removing / replacing that booking then Undo keeps the
 *   confirmation.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import {
  addDays,
  addMonths,
  datesForWeekday,
  formatDateLong,
  formatDateShort,
  formatMonthLong,
  formatTime,
  monthOf,
  todayInTz,
  weekStartOf,
} from '../shared/time';

const DB_FILE = path.resolve(process.env.E2E_DATA_DIR ?? '.data/e2e', 'club.db');
const CLUB_TZ = 'America/New_York'; // the seeded club
const ADMIN = { email: 'admin@example.com', password: 'comedy123' };
const COMIC = { email: 'keisha@example.com', name: 'Keisha Grant', tag: 'Hosts' }; // only this spec uses her
const SHOW = { location: 'The Annex', name: 'Journey Late Set', startMin: 1290, time: '9:30 PM' };

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_FILE);
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The newest email of `kind` to `to` (outbox mode), once it exists. */
async function latestEmailBody(to: string, kind: string, newerThan = 0): Promise<string> {
  let body = '';
  await expect
    .poll(() => {
      const row = withDb((db) =>
        db
          .prepare('SELECT id, body_text FROM email_log WHERE to_email = ? AND kind = ? AND id > ? ORDER BY id DESC LIMIT 1')
          .get(to, kind, newerThan),
      ) as { id: number; body_text: string } | undefined;
      body = row?.body_text ?? '';
      return body;
    })
    .toBeTruthy();
  return body;
}

const maxEmailId = () => withDb((db) => (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM email_log').get() as { n: number }).n);

/** The app path of the first link matching `pattern` in an email body. */
function linkPath(body: string, pattern: RegExp): string {
  const url = body.match(new RegExp(`https?://\\S*${pattern.source}`))?.[0];
  expect(url, `link ${pattern} in:\n${body}`).toBeTruthy();
  return new URL(url!).pathname;
}

/**
 * A dnd-kit mouse drag (it needs a few px of movement before the drag starts). dnd-kit
 * auto-scrolls the page while the pointer is near an edge, so keep re-aiming at the target
 * until it holds still under the pointer and the board shows the drop hint, then drop.
 */
async function drag(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  await target.evaluate('(el) => el.scrollIntoView({ block: "center" })');
  const from = (await source.boundingBox())!;
  const center = async () => {
    const box = (await target.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 });
  let to = await center();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect
    .poll(async () => {
      const next = await center();
      const moved = Math.abs(next.x - to.x) > 1 || Math.abs(next.y - to.y) > 1;
      to = next;
      await page.mouse.move(to.x, to.y, { steps: 2 });
      return moved ? 'still scrolling' : await target.innerText();
    })
    .toMatch(/drop to|replace|swap/i); // "Drop to book", "Not available — drop to ask", "Replace", "Swap"
  await page.mouse.up();
}

async function signInAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('the monthly rhythm, from new shows to a confirmed lineup', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop journey');
  test.setTimeout(120_000);

  const today = todayInTz(CLUB_TZ);
  const nextMonth = addMonths(monthOf(today), 1);
  const saturdays = datesForWeekday(nextMonth, 6);
  const saturday = saturdays[0]!;
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    // Playwright's trace recorder can't inject into the sandboxed email-preview iframe.
    if (msg.type() === 'error' && !msg.text().includes("Blocked script execution in 'about:srcdoc'")) {
      consoleErrors.push(msg.text());
    }
  });

  // 1. Create next month's Saturday late set with the weekday chip ------------------------
  await signInAsAdmin(page);
  await page.goto(`/app/shows/new?month=${nextMonth}`);
  await page.getByLabel('Location').selectOption({ label: SHOW.location });
  await page.getByLabel('Show name').fill(SHOW.name);
  await page.getByLabel('Start').selectOption(String(SHOW.startMin));
  await page.getByLabel('Slots').fill('4');
  await page.getByRole('button', { name: 'Every Saturday' }).click();
  const create = page.getByRole('button', { name: `Create ${saturdays.length} shows` });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText(`Created ${saturdays.length} shows`)).toBeVisible();
  const showCount = () =>
    withDb(
      (db) =>
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM shows WHERE name = ? AND start_min = ? AND status = 'scheduled' AND date LIKE ?`)
            .get(SHOW.name, SHOW.startMin, `${nextMonth}-%`) as { n: number }
        ).n,
    );
  expect(showCount()).toBe(saturdays.length);

  // 2. Ask the Hosts for next month's availability ----------------------------------------
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Request availability' }).click();
  const request = page.getByRole('dialog', { name: 'Request availability' });
  await expect(request.getByLabel('Month')).toHaveValue(nextMonth);
  const hosts = request.getByLabel('Send to').locator('option', { hasText: COMIC.tag });
  await request.getByLabel('Send to').selectOption((await hosts.getAttribute('value'))!);
  const before = maxEmailId();
  await request.getByRole('button', { name: /^Send to \d+ comedians?$/ }).click();
  await expect(page.getByText(/^Availability request sent to \d+ comedians?$/)).toBeVisible();
  const requestEmail = await latestEmailBody(COMIC.email, 'availability_request', before);
  const magicPath = linkPath(requestEmail, /\/portal\/magic\/[\w-]+/);

  // 3. The comedian follows the link (no code) and paints every Saturday 9–11 PM ----------
  const comedianContext = await browser.newContext();
  const comedian = await comedianContext.newPage();
  await comedian.goto(magicPath);
  await expect(comedian).toHaveURL(new RegExp(`/portal\\?month=${nextMonth}$`));
  await expect(comedian.getByRole('heading', { name: formatMonthLong(nextMonth) })).toBeVisible();
  await comedian.getByLabel('Free from').selectOption('1260');
  await comedian.getByLabel('Free until').selectOption('1380');
  await comedian.getByRole('button', { name: 'Mark every Saturday' }).click();
  for (const date of saturdays) await expect(comedian.locator(`[data-date="${date}"]`)).toContainText('9–11 PM');
  await comedian.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(comedian.getByText('Saved — the club can see it now')).toBeVisible();
  await comedianContext.close();

  // 4. Back as the booker: the Saturday's day board, from the calendar ---------------------
  await page.goto(`/app/calendar?month=${nextMonth}`);
  await page
    .getByRole('grid', { name: /^Shows in / })
    .getByRole('gridcell', { name: formatDateLong(saturday) })
    .click({ position: { x: 10, y: 10 } }); // the day number, not a show pill
  await expect(page).toHaveURL(new RegExp(`/app/day/${saturday}$`));

  const pool = page.getByRole('complementary', { name: 'Comedians' });
  const lineup = page.getByRole('list', { name: `${SHOW.time} ${SHOW.name} lineup` });
  await expect(lineup.getByRole('button', { name: /^Slot \d, empty/ })).toHaveCount(4);
  await pool.getByLabel('Search comedians').fill(COMIC.name.split(' ')[0]!);
  const comicCard = pool.getByRole('button', { name: new RegExp(`^${COMIC.name}\\. available 9–11 PM`) });
  await expect(comicCard).toBeVisible();
  await drag(page, comicCard, lineup.getByRole('button', { name: /^Slot 1, empty/ }));
  await expect(lineup.getByRole('button', { name: new RegExp(`^Slot 1: ${COMIC.name}, Not sent$`) })).toBeVisible();

  // Someone who isn't free then: "Book anyway".
  const unavailable = withDb(
    (db) =>
      db
        .prepare(
          `SELECT c.name FROM comedians c WHERE c.archived = 0 AND c.email != ? AND NOT EXISTS (
             SELECT 1 FROM availability a WHERE a.comedian_id = c.id AND a.date = ?
           ) ORDER BY c.name LIMIT 1`,
        )
        .get(COMIC.email, saturday) as { name: string },
  ).name;
  await pool.getByLabel('Search comedians').fill(unavailable);
  const unavailableCard = pool.getByRole('button', { name: new RegExp(`^${unavailable}\\. (unavailable|not marked)`) });
  await drag(page, unavailableCard, lineup.getByRole('button', { name: /^Slot 2, empty/ }));
  const ask = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'isn’t available during this slot' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Book anyway' }).click();
  await expect(
    lineup.getByRole('button', { name: `Slot 2: ${unavailable}, Not sent, booked anyway (not marked available)` }),
  ).toBeVisible();
  const saturdayBookings = withDb(
    (db) =>
      db
        .prepare(
          `SELECT c.name, b.position, b.override_unavailable AS override FROM bookings b
           JOIN shows s ON s.id = b.show_id JOIN comedians c ON c.id = b.comedian_id
           WHERE s.date = ? AND s.name = ? ORDER BY b.position`,
        )
        .all(saturday, SHOW.name) as { name: string; position: number; override: number }[],
  );
  expect(saturdayBookings).toEqual([
    { name: COMIC.name, position: 0, override: 0 },
    { name: unavailable, position: 1, override: 1 },
  ]);

  // 5. Send this week's confirmations from the dashboard -----------------------------------
  const weekEnd = addDays(weekStartOf(today), 6);
  const target = withDb(
    (db) =>
      db
        .prepare(
          `SELECT c.id, c.name, c.email, s.date, s.start_min AS startMin, s.name AS showName, b.position
           FROM bookings b JOIN shows s ON s.id = b.show_id JOIN comedians c ON c.id = b.comedian_id
           WHERE s.date BETWEEN ? AND ? AND s.status = 'scheduled' AND b.confirmed_at IS NULL AND c.archived = 0
           ORDER BY s.date DESC, c.id LIMIT 1`,
        )
        .get(today, weekEnd) as
        | { id: number; name: string; email: string; date: string; startMin: number; showName: string; position: number }
        | undefined,
  );
  expect(target, 'the seed has unconfirmed spots this week').toBeTruthy();
  const unconfirmed = () =>
    withDb(
      (db) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM bookings b JOIN shows s ON s.id = b.show_id
               WHERE b.comedian_id = ? AND s.date BETWEEN ? AND ? AND s.status = 'scheduled' AND b.confirmed_at IS NULL`,
            )
            .get(target!.id, today, weekEnd) as { n: number }
        ).n,
    );

  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Send confirmations now' }).click();
  const sendDialog = page.getByRole('dialog', { name: "Send this week's confirmations?" });
  const beforeConfirmations = maxEmailId();
  await sendDialog.getByRole('button', { name: /^Send \d+ emails?$/ }).click();
  await expect(page.getByText(/^Sent \d+ confirmation emails?$/)).toBeVisible();
  await expect(sendDialog).toBeHidden();
  const confirmEmail = await latestEmailBody(target!.email, 'confirmation', beforeConfirmations);
  const confirmPath = linkPath(confirmEmail, /\/portal\/confirm\/[\w-]+/);

  // 6. The comedian opens the link: looking changes nothing; the button confirms -----------
  const pending = unconfirmed();
  expect(pending).toBeGreaterThan(0);
  const confirmContext = await browser.newContext();
  const confirmPage = await confirmContext.newPage();
  await confirmPage.goto(confirmPath);
  const firstName = target!.name.split(' ')[0]!;
  await expect(confirmPage.getByRole('heading', { name: new RegExp(`Hey ${firstName}, you're booked`) })).toBeVisible();
  expect(unconfirmed()).toBe(pending); // a GET (or an email scanner) doesn't confirm
  await confirmPage.getByRole('button', { name: /^Confirm my spots?$/ }).click();
  await expect(confirmPage.getByRole('heading', { name: "You're confirmed!" })).toBeVisible();
  expect(unconfirmed()).toBe(0);
  await confirmContext.close();

  // 7. The booker sees it: dashboard → that day's board ---------------------------------
  await page.reload();
  if (target!.date === today) {
    // Tonight's red list no longer has them.
    await expect(page.getByRole('button', { name: `Resend confirmation email to ${target!.name}` })).toHaveCount(0);
  }
  await page
    .getByRole('table', { name: /^Shows, open slots/ })
    .getByRole('link', { name: new RegExp(`${formatDateShort(target!.date)}\\b`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/day/${target!.date}$`));
  const slotNumber = target!.position + 1;
  const showTitle = `${formatTime(target!.startMin)} ${target!.showName || 'show'}`;
  const showList = page.getByRole('list', { name: `${showTitle} lineup` });
  const confirmedChip = showList.getByRole('button', { name: new RegExp(`^Slot ${slotNumber}: ${target!.name}, Confirmed`) });
  await expect(confirmedChip).toBeVisible();

  // Removing it and pressing Undo keeps the confirmation (it's restored exactly).
  const chipName = (await confirmedChip.getAttribute('aria-label'))!;
  await showList.getByRole('button', { name: `Remove ${target!.name} from slot ${slotNumber}` }).click();
  await expect(showList.getByRole('button', { name: new RegExp(`^Slot ${slotNumber}, empty`) })).toBeVisible();
  const removedToast = page.locator('[data-sonner-toast]').filter({ hasText: `Removed ${target!.name}` });
  await removedToast.getByRole('button', { name: 'Undo' }).click();
  await expect(showList.getByRole('button', { name: chipName })).toBeVisible();
  expect(unconfirmed()).toBe(0);

  // Dropping a pool comedian on the slot replaces them; Undo puts them back, still confirmed.
  const replacement = withDb(
    (db) =>
      db
        .prepare(
          `SELECT c.name FROM comedians c WHERE c.archived = 0 AND c.id NOT IN (
             SELECT b.comedian_id FROM bookings b JOIN shows s ON s.id = b.show_id WHERE s.date = ?
           ) ORDER BY c.name LIMIT 1`,
        )
        .get(target!.date) as { name: string },
  ).name;
  await pool.getByLabel('Search comedians').fill(replacement);
  await drag(
    page,
    pool.getByRole('button', { name: new RegExp(`^${replacement}\\.`) }),
    showList.getByRole('button', { name: chipName }),
  );
  const askAgain = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'isn’t available' });
  // The replacement may not be free that night: book anyway.
  await expect(showList.getByRole('button', { name: new RegExp(`^Slot ${slotNumber}: ${replacement}`) }).or(askAgain)).toBeVisible();
  if (await askAgain.isVisible()) await askAgain.getByRole('button', { name: 'Book anyway' }).click();
  await expect(showList.getByRole('button', { name: new RegExp(`^Slot ${slotNumber}: ${replacement}`) })).toBeVisible();
  const replacedToast = page.locator('[data-sonner-toast]').filter({ hasText: `Replaced ${target!.name} with ${replacement}` });
  await replacedToast.getByRole('button', { name: 'Undo' }).click();
  await expect(showList.getByRole('button', { name: chipName })).toBeVisible();
  await expect(showList.getByRole('button', { name: new RegExp(`^Slot \\d+: ${replacement}`) })).toHaveCount(0);
  expect(unconfirmed()).toBe(0);

  expect(consoleErrors).toEqual([]);
});
