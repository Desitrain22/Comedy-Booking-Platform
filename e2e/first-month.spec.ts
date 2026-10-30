/**
 * A new club's first month, start to finish, the way a club manager would do it (onboarding
 * design §5). Runs in the `first-month` project: `npm run e2e` gives it its own server on an
 * empty data folder (playwright.config.ts).
 *
 *   /setup (club, room, login) → the guide on Create shows: tap the Friday chip → Create → (at
 *   1024 px the "N shows on the calendar" card keeps clear of the calendar's heading) → Next →
 *   Comedians: Import CSV with an 8-row spreadsheet (first + last name columns, phones, notes,
 *   a duplicate, a bad email, an extra column) → the guide counts 6 on the roster → Next →
 *   dashboard: Connect email (the card sits above the form, clear of its "Not configured"
 *   badge) → Back to the guide → Send anyway (email isn't set up: outbox) → "You're set up" →
 *   Done. Then the manager reads the outbox (Settings → Email → Email log), opens a comedian's
 *   availability email and its link on a phone: signed in as her, on the month with the shows.
 */
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { formatMonthLong, formatMonthName } from '../shared/time';
import { withClubDb } from './db';

const MANAGER = { name: 'Rich Brooks', email: 'rich@brooksroom.example', password: 'brooks-room-2026' };

/** The roster as the club keeps it: what they'd export from their spreadsheet. */
const ROSTER_CSV = [
  'First Name,Last Name,Email,Cell,Notes,Agent',
  'Maria,Delgado,maria.delgado@gmail.com,(212) 555-0101,"Great closer, clean set available",',
  'Jason,Lee,jlee.comedy@gmail.com,,Hosts Tuesdays,CAA',
  'Priya,Shah,priya@priyashah.com,917-555-0144,,',
  'Tom,Walsh,tom.walsh@outlook,,,',
  'Dana,Kim,dana.kim@gmail.com,646.555.0188,"Needs to be off by 10, has a ""day job""",',
  'Marcus,Bell,marcus.bell@yahoo.com,,,',
  'Jason,Lee,JLEE.comedy@gmail.com,,,',
  'Sofia,Russo,sofia.russo@gmail.com,+1 718 555 0123 ext 2,New in town - saw her at the open mic,',
].join('\r\n');

/** The coach card: a labelled, non-modal dialog. */
const coach = (page: Page, title: string | RegExp) => page.locator('[data-guide-card]').and(page.getByRole('dialog', { name: title }));

async function overlap(a: Locator, b: Locator): Promise<boolean> {
  const [x, y] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!x || !y) return false;
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
}

/** Wait until an element (the coach card gliding to its spot) stops moving. */
async function settled(locator: Locator): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await locator.boundingBox());
        const still = box === previous;
        previous = box;
        return still;
      },
      { intervals: [300] },
    )
    .toBe(true);
}

async function onboarding(page: Page) {
  return (await (await page.request.get('/api/onboarding')).json()) as {
    suggestedMonth: string;
    counts: { scheduledShows: number };
    steps: { key: string; status: string }[];
  };
}

test('a new club gets through its first month: setup, shows, CSV import, availability, a comedian signs in', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const status = (await (await page.request.get('/api/setup/status')).json()) as { setupComplete: boolean };
  test.skip(status.setupComplete && Boolean(process.env.E2E_BASE_URL), 'needs a fresh, unseeded club (see the file comment)');
  expect(status.setupComplete, 'the `first-month` project starts its server on an empty data folder').toBe(false);

  // --- Step 1 of 3: the setup wizard -------------------------------------------------------
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Set up your club' })).toBeVisible();
  await page.getByLabel('Club name').fill('The Brooks Room');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Location name').fill('Main Room');
  await page.getByLabel('Address (optional)').fill('123 Bleecker St, New York, NY');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill(MANAGER.name);
  await page.getByLabel('Email').fill(MANAGER.email);
  await page.getByLabel('Password').fill(MANAGER.password);
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // --- Step 2 of 3: shows, with the weekday chips -------------------------------------------
  await expect(page).toHaveURL(/\/app\/shows\/new\?month=\d{4}-\d{2}$/);
  const month = new URL(page.url()).searchParams.get('month')!;
  const first = coach(page, 'Your first show');
  await expect(first).toContainText('Step 2 of 3 · Shows');
  await first.getByRole('button', { name: 'Next' }).click();
  await expect(coach(page, 'Put it on the calendar')).toContainText('Tap F');

  // Fridays first; on a short month (planning this month, late in it) add more weekdays.
  for (const day of ['Friday', 'Saturday', 'Thursday']) {
    await page.getByRole('button', { name: `Every ${day}` }).click();
    await expect(coach(page, /^\d+ shows? ready$/)).toBeVisible();
    await page.getByRole('button', { name: /^Create \d+ shows?$/ }).click();
    await expect(page.getByText(/^Created \d+ shows?$/).first()).toBeVisible();
    await expect.poll(async () => (await onboarding(page)).counts.scheduledShows).toBeGreaterThan(0);
    const { steps } = await onboarding(page);
    if (steps.find((s) => s.key === 'shows')?.status === 'done') break;
    await expect(coach(page, /^\d+ shows? on the calendar$/)).toContainText('Add a couple more');
  }
  const { counts } = await onboarding(page);
  expect(counts.scheduledShows).toBeGreaterThanOrEqual(3);
  const showsDone = coach(page, `${counts.scheduledShows} shows on the calendar`);
  await expect(showsDone).toContainText('Next: the comedians you book');

  // On a 1024 × 768 laptop the calendar fills the screen; the card must not hide its heading.
  await page.setViewportSize({ width: 1024, height: 768 });
  const calendarHeading = page.getByRole('heading', { name: formatMonthLong(month) });
  await expect(calendarHeading).toBeInViewport();
  await settled(showsDone);
  await expect(showsDone).toBeInViewport();
  expect(await overlap(showsDone, calendarHeading)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 720 });
  await showsDone.getByRole('button', { name: 'Next' }).click();

  // --- Step 3 of 3: comedians, from a CSV ---------------------------------------------------
  await expect(page).toHaveURL(/\/app\/comedians$/);
  await expect(coach(page, 'Add your comedians')).toContainText('Step 3 of 3 · Comedians');
  await page.getByRole('button', { name: 'Import CSV' }).first().click();
  const importDialog = page.getByRole('dialog', { name: 'Import comedians from a CSV' });
  await importDialog.getByLabel('CSV file').setInputFiles({
    name: 'brooks-room-comedians.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(ROSTER_CSV),
  });
  await expect(importDialog).toContainText('8 rows');
  await expect(importDialog).toContainText('Ignored: Agent');
  const row = (name: string, nth = 0) => importDialog.getByRole('row').filter({ hasText: name }).nth(nth);
  await expect(row('Maria Delgado')).toContainText('(212) 555-0101');
  await expect(row('Maria Delgado')).toContainText('New');
  await expect(row('Tom Walsh')).toContainText('Invalid email');
  await expect(row('Jason Lee', 1)).toContainText('Duplicate in file');
  await expect(importDialog).toContainText('6 will be added · 2 skipped');
  await expect(importDialog.getByRole('checkbox', { name: 'Email each new comedian a sign-in link' })).toBeChecked();
  await importDialog.getByRole('button', { name: 'Import 6 comedians' }).click();
  await expect(importDialog).toBeHidden();
  await expect(page.getByText('Imported 6 comedians · skipped 2')).toBeVisible();

  // The guide saw them arrive.
  const roster = coach(page, '6 comedians on the roster');
  await expect(roster).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Sofia Russo' })).toContainText('+1 718 555 0123 ext 2');
  await roster.getByRole('button', { name: 'Next' }).click();

  // --- Ask who's free: email isn't connected ------------------------------------------------
  await expect(page).toHaveURL(/\/app$/);
  const ask = coach(page, 'Ask who’s free');
  await expect(ask).toContainText(`Send your comedians the ${formatMonthName(month)} availability request`);
  await expect(ask).toContainText('wait in the outbox');
  await ask.getByRole('button', { name: 'Connect email' }).click();

  // The email settings: the card sits above the form, clear of the "Not configured" badge.
  await expect(page).toHaveURL(/\/app\/settings\/email$/);
  const connect = coach(page, 'Connect your email');
  await expect(connect).toBeVisible();
  await settled(connect);
  const badge = page.getByText('Not configured', { exact: true });
  await expect(badge).toBeVisible();
  expect(await overlap(connect, badge)).toBe(false);
  await connect.getByRole('button', { name: 'Back to the guide' }).click();

  // Not today: send anyway, into the outbox.
  await expect(page).toHaveURL(/\/app$/);
  await ask.getByRole('button', { name: 'Send anyway' }).click();
  const request = page.getByRole('dialog', { name: 'Request availability' });
  await expect(request.getByLabel('Month')).toHaveValue(month);
  await expect(request.getByLabel('Send to')).toHaveValue('all');
  await request.getByRole('button', { name: 'Send to 6 comedians' }).click();

  const finish = coach(page, 'You’re set up');
  await expect(finish).toContainText('Comedians mark the nights they’re free');
  await expect(finish).toContainText('waiting in the outbox');
  await finish.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-guide-card]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Setup guide progress' })).toHaveCount(0);

  // The CSV notes became private notes, written by the manager.
  await page.getByRole('link', { name: 'Comedians' }).first().click();
  await page.getByRole('link', { name: 'Dana Kim' }).click();
  await expect(page.getByText('Needs to be off by 10, has a "day job"')).toBeVisible();
  const notes = withClubDb(
    (db) =>
      db
        .prepare('SELECT COUNT(*) AS n FROM notes JOIN users ON users.id = notes.author_id WHERE users.email = ?')
        .get(MANAGER.email) as { n: number },
  );
  expect(notes.n).toBe(4);

  // --- The outbox: the manager passes Dana her link -----------------------------------------
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('tab', { name: 'Email' }).click();
  await page.getByRole('searchbox', { name: 'Search emails' }).fill('dana.kim');
  const availabilityEmail = page.getByRole('button', { name: /is booking .* when are you free\?$/ });
  await expect(availabilityEmail).toHaveCount(1);
  await availabilityEmail.click();
  const email = page.getByRole('dialog', { name: /is booking .* when are you free\?$/ });
  await expect(email).toContainText('not sent');
  const link = await email.getByRole('link', { name: 'Open link in a new tab' }).getAttribute('href');
  expect(link).toMatch(/\/portal\/magic\/[\w-]+$/);

  // --- Dana, on her phone -------------------------------------------------------------------
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const dana = await phone.newPage();
  await dana.goto(new URL(link!).pathname);
  await expect(dana).toHaveURL(new RegExp(`/portal\\?month=${month}$`));
  await expect(dana.getByText('Hey Dana')).toBeVisible();
  await expect(dana.getByRole('heading', { level: 1, name: formatMonthLong(month) })).toBeVisible();
  await expect(dana.getByRole('button', { name: 'Save' })).toBeVisible();
  await phone.close();
});
