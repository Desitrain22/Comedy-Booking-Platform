/**
 * The setup guide on a FRESH, unseeded club, then the welcome tour for an invited booker
 * (onboarding design §2, §5). Desktop only.
 *
 *   /setup → the guide lands on Create shows (step 2 of 3) and survives a reload → one show,
 *   then the weekday chips until there are 3 ("Add a couple more" in between) → Next →
 *   Comedians: add one with the Add comedian dialog → Next → dashboard: Request availability,
 *   pre-filled with the month that has the shows, sent to the outbox ("Send anyway") →
 *   "You're set up" → Done, and it never starts again. In between: Skip guide + resume from
 *   the user menu, Esc → pill → Resume, and reloads mid-guide.
 *   Invited booker: invite via the API, accept the link → the 4-stop welcome tour → Done →
 *   it doesn't come back.
 *
 * The fresh-club tests need a server on an unseeded data dir; against a seeded club (plain
 * `npm run e2e`) they skip and only the welcome tour runs:
 *
 *   rm -rf .data/guide && DATA_DIR=.data/guide PORT=3520 VITE_PORT=5520 npm run dev
 *   E2E_BASE_URL=http://localhost:5520 E2E_DATA_DIR=.data/guide npx playwright test e2e/onboarding.spec.ts
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DB_FILE = path.resolve(process.env.E2E_DATA_DIR ?? '.data/e2e', 'club.db');
const FOUNDER = { name: 'Rich Brooks', email: 'rich@guide.example', password: 'laughs-1234' };
const SEEDED_ADMIN = { email: 'admin@example.com', password: 'comedy123' };
const COMEDIAN = { name: 'Jason Lee', email: 'jason@guide.example' };

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_FILE);
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The coach card: a labelled, non-modal dialog. */
const coach = (page: Page, title: string | RegExp) => page.locator('[data-guide-card]').and(page.getByRole('dialog', { name: title }));
const anyCoach = (page: Page) => page.locator('[data-guide-card]');
const rail = (page: Page) => page.getByRole('region', { name: 'Setup guide progress' });

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app/);
}

async function openUserMenu(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Account menu' }).first().click();
  return page.getByRole('menu');
}

let freshClub = false;

test.beforeAll(async ({ request }) => {
  const status = (await (await request.get('/api/setup/status')).json()) as { setupComplete: boolean };
  freshClub = !status.setupComplete;
});

test.describe.serial('setup guide on a fresh club', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop guide');
  });

  test('/setup hands over to the guide, which walks the shows step', async ({ page }) => {
    test.skip(!freshClub, 'needs a fresh, unseeded club (see the file comment)');
    test.setTimeout(90_000);

    // Step 1 of 3: the setup wizard.
    await page.goto('/setup');
    await expect(page.getByRole('list', { name: 'Setup guide' })).toContainText('Club');
    await page.getByLabel('Club name').fill('The Guided Club');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Location name').fill('The Cellar');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Your name').fill(FOUNDER.name);
    await page.getByLabel('Email').fill(FOUNDER.email);
    await page.getByLabel('Password').fill(FOUNDER.password);
    await page.getByRole('button', { name: 'Finish setup' }).click();

    // Step 2: Create shows for the planning month, the form lit.
    await expect(page).toHaveURL(/\/app\/shows\/new\?month=\d{4}-\d{2}$/);
    const month = new URL(page.url()).searchParams.get('month')!;
    await expect(coach(page, 'Your first show')).toBeVisible();
    await expect(coach(page, 'Your first show')).toContainText('Step 2 of 3 · Shows');
    await expect(rail(page)).toContainText(/Shows\s*· 0 of 3/);
    await expect(page.locator('[data-guide="shows-form"][data-guide-lit]')).toBeVisible();

    // A reload mid-guide resumes where it was.
    await page.reload();
    await expect(coach(page, 'Your first show')).toBeVisible();

    await coach(page, 'Your first show').getByRole('button', { name: 'Next' }).click();
    const days = coach(page, 'Put it on the calendar');
    await expect(days).toContainText('Tap F');
    await expect(days.getByRole('button', { name: 'Next' })).toHaveCount(0); // waits for dates

    // One show first: pick a single day → "1 show ready" → Create.
    const grid = page.getByRole('grid', { name: /^Dates for new shows/ });
    await grid.locator('[data-date]:not([aria-disabled="true"])').last().click();
    await expect(coach(page, '1 show ready')).toBeVisible();
    await page.getByRole('button', { name: 'Create 1 show', exact: true }).click();
    const more = coach(page, '1 show on the calendar');
    await expect(more).toContainText('Add a couple more');
    await expect(rail(page)).toContainText('1 of 3');

    // Then the weekday chips until there will be at least 3.
    for (const chip of ['Every Friday', 'Every Saturday', 'Every Thursday']) {
      await page.getByRole('button', { name: chip }).click();
      await expect(coach(page, /^\d+ shows? ready$/)).toBeVisible();
      const label = await page.getByRole('button', { name: /^Create \d+ shows?$/ }).innerText();
      if (Number(label.match(/\d+/)![0]) >= 2) break;
    }
    await page.getByRole('button', { name: /^Create \d+ shows?$/ }).click();
    const done = coach(page, /^\d+ shows on the calendar$/);
    await expect(done).toBeVisible();
    await expect(rail(page).getByRole('listitem').filter({ hasText: 'Shows' })).toContainText('(done)');
    const scheduled = withDb(
      (db) => (db.prepare(`SELECT COUNT(*) AS n FROM shows WHERE status = 'scheduled'`).get() as { n: number }).n,
    );
    expect(scheduled).toBeGreaterThanOrEqual(3);
    await expect(done).toContainText(`${scheduled} shows on the calendar`);

    // Next → step 3 on the roster, Import CSV + Add comedian lit.
    await done.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/\/app\/comedians$/);
    await expect(coach(page, 'Add your comedians')).toContainText('Step 3 of 3 · Comedians');
    await expect(page.locator('[data-guide="comedians-add"][data-guide-lit]')).toBeVisible();
    expect(month).toMatch(/^\d{4}-\d{2}$/);
  });

  test('skip the guide, then resume it from the user menu; Esc minimizes it', async ({ page }) => {
    test.skip(!freshClub, 'needs a fresh, unseeded club (see the file comment)');

    // Signing in again resumes at the current step (comedians), wherever the booker lands.
    await signIn(page, FOUNDER);
    await expect(coach(page, 'Next: your comedians')).toBeVisible();
    await expect(page.locator('[data-guide="nav-comedians"][data-guide-lit]')).toBeVisible();

    // Esc → "Setup guide · Step 3 of 3 — Resume" pill → back.
    await page.keyboard.press('Escape');
    await expect(anyCoach(page)).toHaveCount(0);
    const pill = page.getByRole('button', { name: /Setup guide · Step 3 of 3.*Resume/ });
    await expect(pill).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
    await pill.click();
    await expect(coach(page, 'Next: your comedians')).toBeVisible();

    // Skip guide: gone, and it stays gone after a reload.
    await coach(page, 'Next: your comedians').getByRole('button', { name: 'Skip guide' }).click();
    await expect(anyCoach(page)).toHaveCount(0);
    await expect(rail(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('getting-started')).toBeVisible();
    await expect(anyCoach(page)).toHaveCount(0);

    // Resume from the user menu.
    const menu = await openUserMenu(page);
    await menu.getByRole('menuitem', { name: 'Setup guide' }).click();
    await expect(coach(page, 'Next: your comedians')).toBeVisible();
    await expect(rail(page)).toContainText('Comedians');

    // …and it starts on its own again after a reload (the skip was cleared).
    await page.reload();
    await expect(coach(page, 'Next: your comedians')).toBeVisible();
    await coach(page, 'Next: your comedians').getByRole('button', { name: 'Go to Comedians' }).click();
    await expect(page).toHaveURL(/\/app\/comedians$/);
    await expect(coach(page, 'Add your comedians')).toBeVisible();
  });

  test('comedians → request availability (outbox) → "You’re set up"', async ({ page }) => {
    test.skip(!freshClub, 'needs a fresh, unseeded club (see the file comment)');
    test.setTimeout(60_000);

    await signIn(page, FOUNDER);
    await page.goto('/app/comedians');
    await expect(coach(page, 'Add your comedians')).toBeVisible();

    // Add one comedian with the plain dialog (the guide keeps tracking while it's open).
    await page.getByRole('button', { name: 'Add comedian' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add comedian' });
    await expect(dialog).toBeVisible();
    // The card steps aside for the dialog; a hint says the guide is still there. (Radix hides
    // everything outside the dialog from assistive tech, so this is a plain locator.)
    await expect(anyCoach(page)).toHaveCount(0);
    await expect(page.locator('[data-guide-root] [role="status"]')).toContainText('Setup guide');
    await dialog.getByRole('textbox', { name: 'Name' }).fill(COMEDIAN.name);
    await dialog.getByRole('textbox', { name: 'Email' }).fill(COMEDIAN.email);
    await dialog.getByRole('button', { name: 'Add comedian' }).click();
    const roster = coach(page, '1 comedian on the roster');
    await expect(roster).toBeVisible();

    // Reload mid-step: still here.
    await page.reload();
    await expect(coach(page, '1 comedian on the roster')).toBeVisible();
    await coach(page, '1 comedian on the roster').getByRole('button', { name: 'Next' }).click();

    // Dashboard: Request availability lit; email isn't connected, so "Send anyway".
    await expect(page).toHaveURL(/\/app$/);
    const ask = coach(page, 'Ask who’s free');
    await expect(ask).toContainText('outbox');
    await expect(ask.getByRole('button', { name: 'Connect email' })).toBeVisible();
    await expect(page.locator('[data-guide="dashboard-request-availability"][data-guide-lit]')).toBeVisible();
    const { suggestedMonth } = (await (await page.request.get('/api/onboarding')).json()) as { suggestedMonth: string };
    await ask.getByRole('button', { name: 'Send anyway' }).click();

    // The dialog opens on the month with the shows, audience everyone.
    const request = page.getByRole('dialog', { name: 'Request availability' });
    await expect(request).toBeVisible();
    await expect(request.getByLabel('Month')).toHaveValue(suggestedMonth);
    await expect(request.getByLabel('Send to')).toHaveValue('all');
    await request.getByRole('button', { name: 'Send to 1 comedian' }).click();

    // "You're set up" → Done.
    const finish = coach(page, 'You’re set up');
    await expect(finish).toBeVisible();
    await expect(finish).toContainText('drag comedians');
    const outbox = withDb(
      (db) =>
        db
          .prepare(`SELECT status FROM email_log WHERE to_email = ? AND kind = 'availability_request' ORDER BY id DESC LIMIT 1`)
          .get(COMEDIAN.email) as { status: string } | undefined,
    );
    expect(outbox?.status).toBe('outbox');
    await finish.getByRole('button', { name: 'Done' }).click();
    await expect(anyCoach(page)).toHaveCount(0);
    await expect(rail(page)).toHaveCount(0);

    // Finished: never starts on its own again, and the checklist is gone.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Availability' })).toBeVisible();
    await expect(anyCoach(page)).toHaveCount(0);
    await expect(page.getByTestId('getting-started')).toHaveCount(0);
    const completed = withDb(
      (db) => db.prepare('SELECT guide_completed_at AS at FROM users WHERE email = ?').get(FOUNDER.email) as { at: number | null },
    );
    expect(completed.at).toEqual(expect.any(Number));
  });
});

test('an invited booker sees the welcome tour once', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop guide');
  const admin = existsSync(DB_FILE) && withDb((db) => db.prepare('SELECT 1 FROM users WHERE email = ?').get(FOUNDER.email))
    ? FOUNDER
    : SEEDED_ADMIN;
  await signIn(page, admin);

  // Invite through the API (the link is returned even when email isn't set up).
  const email = `tour-${Date.now()}@guide.example`;
  const invite = await page.request.post('/api/users', { data: { name: 'Tess Tour', email, role: 'booker', sendEmail: false } });
  expect(invite.status()).toBe(201);
  const { inviteUrl } = (await invite.json()) as { inviteUrl: string };

  const context = await browser.newContext();
  const booker = await context.newPage();
  await booker.goto(new URL(inviteUrl).pathname);
  await booker.getByLabel('Password', { exact: true }).fill('tour-pass-123');
  await booker.getByLabel('Confirm password').fill('tour-pass-123');
  await booker.getByRole('button', { name: 'Accept invite' }).click();
  await expect(booker).toHaveURL(/\/app$/);

  // Four informational stops over the nav, no setup rail.
  const stops = [
    { title: 'Your dashboard', target: 'nav-dashboard' },
    { title: 'The calendar', target: 'nav-calendar', text: 'Click a day to build its lineups' },
    { title: 'Your comedians', target: 'nav-comedians', text: 'notes and tags' },
    { title: 'Settings', target: 'nav-settings' },
  ];
  for (const [i, stop] of stops.entries()) {
    const card = coach(booker, stop.title);
    await expect(card).toBeVisible();
    await expect(card).toContainText(`Welcome tour · ${i + 1} of 4`);
    if (stop.text) await expect(card).toContainText(stop.text);
    await expect(booker.locator(`[data-guide="${stop.target}"][data-guide-lit]`)).toBeVisible();
    await expect(rail(booker)).toHaveCount(0);
    if (i === 1) {
      // Back works on informational stops.
      await card.getByRole('button', { name: 'Back' }).click();
      await expect(coach(booker, stops[0]!.title)).toBeVisible();
      await coach(booker, stops[0]!.title).getByRole('button', { name: 'Next' }).click();
    }
    await card.getByRole('button', { name: i === stops.length - 1 ? 'Done' : 'Next' }).click();
  }
  await expect(anyCoach(booker)).toHaveCount(0);

  // Shown once: not after a reload, nor a fresh sign-in; the user menu can replay it.
  await booker.reload();
  await expect(booker.getByRole('heading', { name: 'Availability' })).toBeVisible();
  await expect(anyCoach(booker)).toHaveCount(0);
  const menu = await openUserMenu(booker);
  await expect(menu.getByRole('menuitem', { name: 'Welcome tour' })).toBeVisible();
  await booker.keyboard.press('Escape');
  await context.close();
});
