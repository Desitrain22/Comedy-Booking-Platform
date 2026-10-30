/**
 * Hosted mode: many clubs on one server (hosted MVP spec §3–4). Runs in the `hosted` project:
 * `npm run e2e` starts a server with PLATFORM_URL=http://localhost:5996 on an empty data folder
 * (playwright.config.ts). The platform site is http://localhost:5996 and each club is
 * http://<slug>.localhost:5996 (Chromium resolves *.localhost to this machine).
 *
 *   sign up Alpha on the platform site → signed in on alpha.localhost, on the guide's Shows step
 *   sign up Bravo → Bravo's roster has none of Alpha's comedians; Bravo's cookie is no good on Alpha
 *   find my club → one email with the club's sign-in link
 *   an unknown address → "There's no club at this address"
 *   a suspended club → the paused page, and its API answers 403 club_suspended
 *
 * Against a server you started yourself (a fresh data folder: sign-up takes the slugs below):
 *
 *   rm -rf .data/hosted && DATA_DIR=.data/hosted PORT=3520 VITE_PORT=5520 \
 *     PLATFORM_URL=http://localhost:5520 SUPPORT_EMAIL=help@hosted.example npm run dev
 *   E2E_BASE_URL=http://localhost:5520 E2E_DATA_DIR=.data/hosted npx playwright test --project=hosted
 */
import { expect, test, type Page } from '@playwright/test';
import { setClubStatus, withHostedClubDb, withPlatformDb } from './db';

const PLATFORM = process.env.E2E_BASE_URL ?? 'http://localhost:5996';
const PLATFORM_HOST = new URL(PLATFORM).host;
const clubUrl = (slug: string, path = '') => `${new URL(PLATFORM).protocol}//${slug}.${PLATFORM_HOST}${path}`;

interface Founder {
  company: string;
  slug: string;
  location: string;
  name: string;
  email: string;
  password: string;
}

const ALPHA: Founder = {
  company: 'Alpha Comedy',
  slug: 'alpha',
  location: 'The Alpha Room',
  name: 'Ann Alpha',
  email: 'ann@alpha.example',
  password: 'alpha-laughs-1',
};
const BRAVO: Founder = {
  company: 'Bravo Comedy',
  slug: 'bravo',
  location: 'The Bravo Room',
  name: 'Bob Bravo',
  email: 'bob@bravo.example',
  password: 'bravo-laughs-1',
};
const ALPHA_COMIC = { name: 'Zed Alphaonly', email: 'zed@alpha.example' };

/** The coach card of the setup guide. */
const coach = (page: Page, title: string) => page.locator('[data-guide-card]').and(page.getByRole('dialog', { name: title }));

/** Sign a club up on the platform site; ends signed in on the club's own address. */
async function signUp(page: Page, founder: Founder) {
  await page.goto(`${PLATFORM}/signup`);
  await page.getByLabel('Company name').fill(founder.company);
  // The address follows the company name until it's edited.
  const address = page.getByLabel('Web address');
  await expect(address).toHaveValue(founder.company.toLowerCase().replace(/\s+/g, '-'));
  await address.fill(founder.slug);
  await expect(page.getByText(`${founder.slug}.${PLATFORM_HOST} is available`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Location name').fill(founder.location);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill(founder.name);
  await page.getByLabel('Email').fill(founder.email);
  await page.getByLabel('Password').fill(founder.password);
  await page.getByRole('button', { name: 'Create club' }).click();
  const landed = new RegExp(`^${clubUrl(founder.slug).replace(/[.]/g, '\\.')}/app/shows/new\\?month=\\d{4}-\\d{2}$`);
  await expect(page).toHaveURL(landed);
}

test.describe.serial('hosted mode', () => {
  test.afterAll(() => {
    // Leave the clubs active for anyone poking at the server afterwards.
    for (const slug of [ALPHA.slug, BRAVO.slug]) {
      try {
        setClubStatus(slug, 'active');
      } catch {
        // not created (an earlier test failed)
      }
    }
  });

  test('the platform site: landing page', async ({ page }) => {
    await page.goto(PLATFORM);
    await expect(page.getByRole('heading', { name: 'Book your comedy club in one place.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create your club' })).toHaveAttribute('href', '/signup');
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
  });

  test('sign up → signed in on the club’s own address, on the guide’s Shows step', async ({ page }) => {
    test.setTimeout(60_000);
    await signUp(page, ALPHA);
    await expect(coach(page, 'Your first show')).toBeVisible();
    await expect(coach(page, 'Your first show')).toContainText('Step 2 of 3 · Shows');
    // The one-time token is gone from the address bar.
    expect(new URL(page.url()).hash).toBe('');

    // The owner was told.
    const notice = withPlatformDb(
      (db) =>
        db.prepare(`SELECT to_email, subject FROM platform_email_log WHERE kind = 'signup_notice' ORDER BY id DESC`).get() as
          | { to_email: string; subject: string }
          | undefined,
    );
    expect(notice?.to_email).toBe('owner@hosted.example');
    expect(notice?.subject).toContain(`New club: ${ALPHA.company} — ${ALPHA.slug}.${PLATFORM_HOST}`);

    // Settings → Club shows the address, read-only.
    await page.goto(clubUrl(ALPHA.slug, '/app/settings/club'));
    const address = page.getByLabel('Club address');
    await expect(address).toHaveValue(clubUrl(ALPHA.slug));
    await expect(address).toHaveAttribute('readonly', '');

    // A comedian on Alpha's roster (through Alpha's API, with Alpha's session).
    const added = await page.request.post(clubUrl(ALPHA.slug, '/api/comedians'), { data: ALPHA_COMIC });
    expect(added.status()).toBe(201);
  });

  test('a second club stays isolated', async ({ page, context }) => {
    test.setTimeout(60_000);
    await signUp(page, BRAVO);

    // Bravo's roster has none of Alpha's comedians.
    await page.goto(clubUrl(BRAVO.slug, '/app/comedians'));
    await expect(page.getByRole('heading', { name: 'Comedians', level: 1 })).toBeVisible();
    await expect(page.getByText(ALPHA_COMIC.name)).toHaveCount(0);
    const roster = await page.request.get(clubUrl(BRAVO.slug, '/api/comedians'));
    expect(JSON.stringify(await roster.json())).not.toContain(ALPHA_COMIC.email);
    expect(withHostedClubDb(ALPHA.slug, (db) => db.prepare('SELECT name FROM comedians').all())).toEqual([
      { name: ALPHA_COMIC.name },
    ]);

    // Bravo's session doesn't sign anyone in on Alpha, even with its cookie copied over.
    const bravoCookie = (await context.cookies(clubUrl(BRAVO.slug))).find((c) => c.name === 'cbp_booker');
    expect(bravoCookie).toBeTruthy();
    await context.addCookies([{ name: 'cbp_booker', value: bravoCookie!.value, domain: `${ALPHA.slug}.localhost`, path: '/' }]);
    const me = await (await page.request.get(clubUrl(ALPHA.slug, '/api/auth/me'))).json();
    expect(me.booker).toBeNull();
    expect(me.club.name).toBe(ALPHA.company);
    await page.goto(clubUrl(ALPHA.slug, '/app'));
    await expect(page).toHaveURL(new RegExp(`^${clubUrl(ALPHA.slug).replace(/[.]/g, '\\.')}/login\\?next=`));
  });

  test('find my club emails the sign-in links', async ({ page }) => {
    await page.goto(`${PLATFORM}/signin`);
    await page.getByLabel('Email').fill(ALPHA.email);
    await page.getByRole('button', { name: 'Email me my clubs' }).click();
    await expect(page.getByText(`If ${ALPHA.email} has an account, we've emailed you a link.`)).toBeVisible();
    const sent = withPlatformDb(
      (db) =>
        db.prepare(`SELECT body_text FROM platform_email_log WHERE kind = 'find_club' AND to_email = ?`).get(ALPHA.email) as
          | { body_text: string }
          | undefined,
    );
    expect(sent?.body_text).toContain(`Booker sign-in: ${clubUrl(ALPHA.slug, '/login')}`);
    expect(sent?.body_text).not.toContain(BRAVO.company);
  });

  test('an unknown address shows the no-club page', async ({ page }) => {
    await page.goto(clubUrl('no-such-club', '/app'));
    await expect(page.getByRole('heading', { name: "There's no club at this address" })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Comedy Booking' })).toHaveAttribute('href', PLATFORM);
  });

  test('a suspended club shows the paused page, and its API answers 403', async ({ page }) => {
    setClubStatus(ALPHA.slug, 'suspended', 'e2e');
    try {
      await page.goto(clubUrl(ALPHA.slug, '/app/comedians'));
      await expect(page.getByRole('heading', { name: 'This account is paused' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'help@hosted.example' })).toHaveAttribute('href', 'mailto:help@hosted.example');
      // A comedian arriving from an emailed link sees the same.
      await page.goto(clubUrl(ALPHA.slug, '/portal/login'));
      await expect(page.getByRole('heading', { name: 'This account is paused' })).toBeVisible();

      const res = await page.request.get(clubUrl(ALPHA.slug, '/api/comedians'));
      expect(res.status()).toBe(403);
      expect((await res.json()).code).toBe('club_suspended');
      const host = await (await page.request.get(clubUrl(ALPHA.slug, '/api/host'))).json();
      expect(host).toMatchObject({ mode: 'club', status: 'suspended' });

      // The other club carries on.
      const bravo = await (await page.request.get(clubUrl(BRAVO.slug, '/api/host'))).json();
      expect(bravo).toMatchObject({ mode: 'club', status: 'active', clubName: BRAVO.company });
    } finally {
      setClubStatus(ALPHA.slug, 'active');
    }
    await page.goto(clubUrl(ALPHA.slug, '/login'));
    await expect(page.getByRole('heading', { name: 'This account is paused' })).toHaveCount(0);
  });
});
