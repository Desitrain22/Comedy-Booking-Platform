/**
 * Foundation smoke test against the seeded demo club (`npm run e2e` seeds .data/e2e).
 * Checks routing, guards, both sign-in flows and the layouts — not feature pages'
 * content, so it keeps passing as features replace their placeholders.
 */
import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const DB_FILE = path.resolve(process.env.E2E_DATA_DIR ?? '.data/e2e', 'club.db');
const ADMIN = { email: 'admin@example.com', password: 'comedy123' };

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_FILE);
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The 6-digit code from the newest sign-in email to `email` (outbox mode). */
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

/** Insert a magic-link token for a comedian (what an availability-request email contains). */
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

async function signInAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function expectPageRendered(page: Page) {
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.getByText('Something went wrong on this page.')).toHaveCount(0);
}

test.describe('setup gate', () => {
  test('a set-up club sends /setup away; an unset club sends everything to /setup', async ({ page }) => {
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/portal\/login$/); // / → no session → portal sign-in
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login'); // "Club staff? Sign in"

    // Pretend the club isn't set up yet.
    await page.route('**/api/auth/me', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), setupComplete: false } });
    });
    await page.goto('/app/calendar');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'Set up your club' })).toBeVisible();

    // Client-side validation, then walk the wizard to the last step.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Enter the club name')).toBeVisible();
    await page.getByLabel('Club name').fill('Test Club');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Your first location' })).toBeVisible();
    await page.getByLabel('Location name').fill('Main Room');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Your admin account' })).toBeVisible();
  });
});

test.describe('booker app', () => {
  test('guards /app, signs in, renders every booker route in the layout, signs out', async ({ page }) => {
    await page.goto('/app/comedians');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fcomedians$/);

    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Wrong email or password')).toBeVisible();

    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/comedians$/); // back to ?next

    const nav = page.getByRole('navigation', { name: 'Main' }).first();
    for (const label of ['Dashboard', 'Calendar', 'Comedians', 'Tags', 'Settings']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(page.getByText('The Laugh Track').first()).toBeVisible();

    for (const url of [
      '/app',
      '/app/calendar?month=2026-11',
      '/app/shows/new?month=2026-11',
      '/app/day/2026-11-07',
      '/app/comedians',
      '/app/comedians/1',
      '/app/tags',
      '/app/settings',
      '/app/settings/email',
    ]) {
      await page.goto(url);
      await expectPageRendered(page);
      await expect(nav).toBeVisible();
    }

    // Day and create-shows pages highlight "Calendar".
    await page.goto('/app/day/2026-11-07');
    await expect(nav.getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page');

    // Client-side navigation through the nav.
    await nav.getByRole('link', { name: 'Tags' }).click();
    await expect(page).toHaveURL(/\/app\/tags$/);

    await page.getByRole('button', { name: 'Account menu' }).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
  });

  test('/ goes to /app for a signed-in booker', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/app$/);
  });
});

test.describe('comedian portal', () => {
  test('signs in with an emailed code and shows the portal tabs', async ({ page }) => {
    await page.goto('/portal');
    await expect(page).toHaveURL(/\/portal\/login\?next=%2Fportal$/);

    await page.getByLabel('Email').fill('john@example.com');
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const code = await latestCode('john@example.com');
    await page.getByLabel('6-digit code').fill(code); // auto-submits at 6 digits
    await expect(page).toHaveURL(/\/portal$/);

    await expect(page.getByText('Hey John')).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Portal' });
    for (const label of ['Availability', 'My spots', 'Profile']) {
      await expect(tabs.getByRole('link', { name: label })).toBeVisible();
    }
    await expectPageRendered(page);

    await tabs.getByRole('link', { name: 'My spots' }).click();
    await expect(page).toHaveURL(/\/portal\/spots$/);
    await expectPageRendered(page);
    await tabs.getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\/portal\/profile$/);
    await expectPageRendered(page);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  test('a magic link signs in without a code and lands on its redirect', async ({ page }) => {
    const token = createMagicToken('maria@example.com', '/portal/profile');
    await page.goto(`/portal/magic/${token}`);
    await expect(page).toHaveURL(/\/portal\/profile$/);
    await expect(page.getByText('Hey Maria')).toBeVisible();
  });

  test('confirm links are reachable without a session', async ({ page }) => {
    await page.goto('/portal/confirm/not-a-real-token-but-no-redirect');
    await expect(page).toHaveURL(/\/portal\/confirm\/not-a-real-token-but-no-redirect$/);
    await expect(page.getByText('The Laugh Track').first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Portal' })).toHaveCount(0);
  });
});

test.describe('MonthGrid (dev playground)', () => {
  test('click-drag paints; a drag from a selected day removes', async ({ page }) => {
    await page.goto('/dev/month-grid');
    const grid = page.getByRole('grid', { name: 'Toggle demo' });
    // The second week row is always a full Sun–Sat week, whatever the month.
    const week = grid.getByRole('row').nth(1).getByRole('gridcell');
    const count = page.getByTestId('toggle-count');

    const first = (await week.nth(1).boundingBox())!;
    const last = (await week.nth(4).boundingBox())!;
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 2 }); // fast: skips cells
    await page.mouse.up();
    await expect(count).toHaveText('4 selected');

    // Starting on a selected day removes.
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + first.width * 1.5, first.y + first.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(count).toHaveText('2 selected');

    // Keyboard: Enter toggles the focused day.
    await grid.getByRole('row').nth(2).getByRole('gridcell').nth(3).focus();
    await page.keyboard.press('Enter');
    await expect(count).toHaveText('3 selected');
  });

  test('touch drag paints instead of scrolling, skipping disabled days', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('/dev/month-grid');
    // Paint next month so no day is in the past.
    await page.getByRole('button', { name: 'Next' }).click();
    const grid = page.getByRole('grid', { name: 'Brush demo' });
    await grid.scrollIntoViewIfNeeded();
    const week = grid.getByRole('row').nth(2).getByRole('gridcell');
    const a = (await week.nth(1).boundingBox())!;
    const b = (await week.nth(3).boundingBox())!;
    const scrollBefore = await page.evaluate<number>('window.scrollY');

    const cdp = await context.newCDPSession(page);
    const point = (r: typeof a, dx = 0.5) => ({ x: r.x + r.width * dx, y: r.y + r.height / 2 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(a)] });
    for (const dx of [0.8, 1.3, 1.8]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(a, dx)] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(b)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(page.getByTestId('brush-count')).toHaveText('3 nights marked');
    expect(await page.evaluate<number>('window.scrollY')).toBe(scrollBefore);
    await context.close();
  });
});
