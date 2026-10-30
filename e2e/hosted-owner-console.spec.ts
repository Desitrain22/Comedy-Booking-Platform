/**
 * The owner console (hosted MVP spec §6), in the `hosted` project: the platform site at
 * http://localhost:5996, PLATFORM_ADMIN_EMAILS=owner@hosted.example (playwright.config.ts).
 *
 *   a club signs up → the owner asks for a code at /admin/login (read from platform.db's
 *   platform_email_log) → signs in → sees the club → suspends it (its site shows the paused
 *   page) → reactivates it → downloads a backup → archives it, typing the address
 *   → its address shows "no club"; every action is in the admin event log
 *   at phone width the clubs are stacked cards and nothing scrolls sideways
 *
 * Uses its own club (`carmine`), so it runs alongside e2e/hosted.spec.ts on one fresh server.
 */
import { expect, test, type Page } from '@playwright/test';
import { adminEventsFor, latestAdminCode } from './db';

const PLATFORM = process.env.E2E_BASE_URL ?? 'http://localhost:5996';
const PLATFORM_HOST = new URL(PLATFORM).host;
const clubUrl = (slug: string, path = '') => `${new URL(PLATFORM).protocol}//${slug}.${PLATFORM_HOST}${path}`;

const OWNER = 'owner@hosted.example';
const CLUB = {
  company: 'Carmine Comedy',
  slug: 'carmine',
  owner: 'Cara Carmine',
  email: 'cara@carmine.example',
};

async function signIn(page: Page) {
  await page.goto(`${PLATFORM}/admin`);
  await expect(page).toHaveURL(`${PLATFORM}/admin/login`);
  await expect(page.getByRole('heading', { name: 'Owner console' })).toBeVisible();
  const before = latestAdminCode(OWNER)?.id ?? 0;
  await page.getByLabel('Email').fill(OWNER);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  // A new code (outbox rows are written before the answer; poll anyway).
  await expect.poll(() => latestAdminCode(OWNER)?.id ?? 0).toBeGreaterThan(before);
  await page.getByLabel('Code').fill(latestAdminCode(OWNER)!.code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${PLATFORM}/admin`);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

test.describe.serial('owner console', () => {
  test('a wrong address gets the same answer and no code', async ({ page }) => {
    await page.goto(`${PLATFORM}/admin/login`);
    await page.getByLabel('Email').fill('stranger@hosted.example');
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    expect(latestAdminCode('stranger@hosted.example')).toBeNull();
    await page.getByLabel('Code').fill('123456');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText("That code isn't right or has expired");
  });

  test('sign in → the club → suspend → paused → reactivate → backup → archive', async ({ page, context }) => {
    test.setTimeout(90_000);
    // A club signs up (the sign-up screens themselves are covered by hosted.spec.ts).
    const signup = await page.request.post(`${PLATFORM}/api/platform/signup`, {
      data: {
        clubName: CLUB.company,
        slug: CLUB.slug,
        timezone: 'America/New_York',
        location: { name: 'The Carmine Room' },
        admin: { name: CLUB.owner, email: CLUB.email, password: 'carmine-laughs-1' },
      },
    });
    expect(signup.status()).toBe(201);

    await signIn(page);

    // The overview: totals and the club in the (active) list, linking to its address.
    await expect(page.getByRole('region', { name: 'Totals' })).toContainText('Active clubs');
    const row = page.getByRole('row').filter({ hasText: CLUB.company });
    await expect(row).toContainText(CLUB.email);
    await expect(row.getByRole('link', { name: `Open ${CLUB.slug}.${PLATFORM_HOST}` })).toHaveAttribute(
      'href',
      clubUrl(CLUB.slug),
    );
    // Search narrows the list; the filter chips switch it.
    await page.getByLabel('Search clubs').fill('carm');
    await expect(page).toHaveURL(/[?&]q=carm/);
    await expect(page.getByRole('row')).toHaveCount(2); // header + Carmine
    await page.getByRole('button', { name: /^Suspended/ }).click();
    await expect(page.getByText('No matching clubs')).toBeVisible();
    await page.getByRole('button', { name: /^Active/ }).click();
    await row.getByRole('link', { name: CLUB.company }).click();

    // The club page.
    await expect(page.getByRole('heading', { name: CLUB.company, level: 1 })).toBeVisible();
    await expect(page.getByText(`Signed up`)).toContainText(CLUB.email);
    await expect(page.getByText('Bookers (1)')).toBeVisible();
    await expect(page.getByText('The Carmine Room')).toBeVisible();

    // Suspend, with a reason.
    await page.getByRole('button', { name: 'Suspend' }).click();
    const suspend = page.getByRole('dialog', { name: `Suspend ${CLUB.company}?` });
    await suspend.getByLabel('Reason (optional)').fill('Testing the console');
    await suspend.getByRole('button', { name: 'Suspend club' }).click();
    await expect(suspend).toBeHidden();
    await expect(page.getByText('Suspended — Testing the console', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible();

    // The club's own site is paused.
    const site = await context.newPage();
    await site.goto(clubUrl(CLUB.slug, '/login'));
    await expect(site.getByRole('heading', { name: 'This account is paused' })).toBeVisible();

    // Reactivate: the site is back.
    await page.getByRole('button', { name: 'Reactivate' }).click();
    const reactivate = page.getByRole('dialog', { name: `Reactivate ${CLUB.company}?` });
    await reactivate.getByRole('button', { name: 'Reactivate' }).click();
    await expect(reactivate).toBeHidden();
    await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible();
    await site.goto(clubUrl(CLUB.slug, '/login'));
    await expect(site.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // Download a backup: a SQLite file.
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download backup' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^${CLUB.slug}-backup-\\d{4}-\\d{2}-\\d{2}\\.db$`));
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(await download.path()).subarray(0, 15).toString()).toBe('SQLite format 3');

    // Archive: the button stays off until the address is typed.
    await page.getByRole('button', { name: 'Archive' }).click();
    const archive = page.getByRole('dialog', { name: `Archive ${CLUB.company}?` });
    const confirm = archive.getByRole('button', { name: 'Archive club' });
    await expect(confirm).toBeDisabled();
    await archive.getByLabel(`Type ${CLUB.slug} to confirm`).fill('carmin');
    await expect(confirm).toBeDisabled();
    await archive.getByLabel(`Type ${CLUB.slug} to confirm`).fill(CLUB.slug);
    await confirm.click();
    await expect(archive).toBeHidden();
    await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();

    await site.goto(clubUrl(CLUB.slug, '/login'));
    await expect(site.getByRole('heading', { name: "There's no club at this address" })).toBeVisible();

    // The page's history and the event log behind it.
    await expect(page.getByText('Backup downloaded', { exact: true })).toBeVisible();
    expect(adminEventsFor(CLUB.slug)).toEqual([
      { action: 'suspend', admin_email: OWNER, reason: 'Testing the console' },
      { action: 'reactivate', admin_email: OWNER, reason: '' },
      { action: 'backup_download', admin_email: OWNER, reason: '' },
      { action: 'archive', admin_email: OWNER, reason: '' },
    ]);

    // Archived clubs leave the default list and show under Archived.
    await page.getByRole('link', { name: 'All clubs' }).click();
    await expect(page.getByRole('row').filter({ hasText: CLUB.company })).toHaveCount(0);
    await page.getByRole('button', { name: /^Archived/ }).click();
    await expect(page.getByRole('row').filter({ hasText: CLUB.company })).toContainText('Archived');

    // Sign out.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(`${PLATFORM}/admin/login`);
    const me = await (await page.request.get(`${PLATFORM}/api/platform/admin/me`)).json();
    expect(me).toEqual({ admin: null });
  });

  test('at phone width: stacked cards, nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page);
    await page.getByRole('button', { name: /^All/ }).click();
    const card = page.getByRole('listitem').filter({ hasText: CLUB.company });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Archived');
    await expect(page.getByRole('table')).toBeHidden();
    const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
    expect(overflow).toBeLessThanOrEqual(0);

    await card.getByRole('link', { name: CLUB.company }).click();
    await expect(page.getByRole('heading', { name: CLUB.company, level: 1 })).toBeVisible();
    const detailOverflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
    expect(detailOverflow).toBeLessThanOrEqual(0);

    // Restore it, so the club is usable again for anyone poking at the server afterwards.
    await page.getByRole('button', { name: 'Restore' }).click();
    const restore = page.getByRole('dialog', { name: `Restore ${CLUB.company}?` });
    await restore.getByRole('button', { name: 'Restore' }).click();
    await expect(restore).toBeHidden();
    await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible();
  });
});
