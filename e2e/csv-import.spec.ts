/**
 * Comedians → Import CSV, end to end (desktop; needs a seeded database — `npm run e2e`
 * provides one, or point E2E_BASE_URL / E2E_DATA_DIR at a seeded dev server):
 *
 *   download the template → drop a 5-row CSV (one comedian already on the roster, one bad
 *   email, one with a note, one with a phone) → the columns found and a status per row →
 *   Import 3 comedians → the roster has them, the note is on the new comedian's profile,
 *   the phone shows as a tap-to-call link, and each new comedian was emailed a sign-in link.
 *
 * Emails carry a per-run suffix so the spec can run again against the same database.
 */
import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DB_FILE = path.resolve(process.env.E2E_DATA_DIR ?? '.data/e2e', 'club.db');
const ADMIN = { email: 'admin@example.com', password: 'comedy123' };
const EXISTING = { name: 'Maria Delgado', email: 'maria@example.com' }; // seeded

async function signInAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

/** The browser's DataTransfer (e2e is type-checked without the DOM lib). */
interface BrowserGlobals {
  DataTransfer: new () => { items: { add(file: File): unknown } };
}

/** Drop a file onto an element the way a browser does (dragenter → dragover → drop). */
async function dropFile(page: Page, testId: string, name: string, content: string) {
  const dataTransfer = await page.evaluateHandle(
    ({ name, content }) => {
      const dt = new (globalThis as unknown as BrowserGlobals).DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/csv' }));
      return dt;
    },
    { name, content },
  );
  const zone = page.getByTestId(testId);
  for (const type of ['dragenter', 'dragover', 'drop']) await zone.dispatchEvent(type, { dataTransfer });
}

function loginLinkEmailsTo(emails: string[]): string[] {
  const db = new Database(DB_FILE, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT to_email FROM email_log WHERE kind = 'login_link' AND to_email IN (${emails.map(() => '?').join(',')})`)
      .all(...emails) as { to_email: string }[];
    return rows.map((r) => r.to_email).sort();
  } finally {
    db.close();
  }
}

test('import comedians from a CSV: preview statuses, then create the new ones with notes and phones', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop flow');
  const run = Date.now().toString(36);
  const ana = { name: `Ana Notes ${run}`, email: `ana.${run}@example.com`, note: 'Great closer, clean set available' };
  const ben = { name: `Ben Phone ${run}`, email: `ben.${run}@example.com`, phone: '(212) 555-0142' };
  const cal = { name: `Cal Plain ${run}`, email: `cal.${run}@example.com` };
  const csv = [
    'Name,E-mail,Cell,Notes',
    `${EXISTING.name},${EXISTING.email},,`,
    `Tony Bad,tony-at-example.com,,`,
    `${ana.name},${ana.email},,"${ana.note}"`,
    `${ben.name},${ben.email},${ben.phone},`,
    `${cal.name},${cal.email},,`,
  ].join('\r\n');

  await signInAsAdmin(page);
  await page.goto('/app/comedians');
  await page.locator('[data-guide="comedians-import"]').click();
  const dialog = page.getByRole('dialog', { name: 'Import comedians from a CSV' });
  await expect(dialog).toBeVisible();

  // The template downloads with the four headers and an example row.
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download a template' }).click()]);
  expect(download.suggestedFilename()).toBe('comedians-template.csv');
  const template = readFileSync((await download.path())!, 'utf8');
  expect(template.split('\r\n')[0]).toBe('Name,Email,Phone,Notes');

  await dropFile(page, 'csv-drop-zone', 'roster.csv', csv);
  await expect(dialog.getByText('roster.csv')).toBeVisible();
  await expect(dialog.getByText('· 5 rows')).toBeVisible();

  // Columns found (headers matched loosely: "E-mail", "Cell").
  const columns = dialog.getByTestId('csv-columns');
  for (const field of ['Name', 'Email', 'Phone', 'Notes']) await expect(columns.getByText(field, { exact: true })).toBeVisible();
  await expect(columns.getByLabel('not found')).toHaveCount(0);

  // A status per row; "Already on roster" comes from the server's dry run.
  const preview = dialog.getByTestId('csv-preview');
  const statusOf = (name: string) => preview.getByRole('row').filter({ hasText: name });
  await expect(statusOf(EXISTING.name)).toContainText('Already on roster');
  await expect(statusOf('Tony Bad')).toContainText('Invalid email');
  for (const comic of [ana, ben, cal]) await expect(statusOf(comic.name)).toContainText('New');
  await expect(dialog.getByText('3 will be added · 2 skipped')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Email each new comedian a sign-in link' })).toBeChecked();

  await dialog.getByRole('button', { name: 'Import 3 comedians' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Imported 3 comedians · skipped 2' })).toBeVisible();

  // Exactly the three new comedians are on the roster (the roster refreshed on its own).
  const roster = page.locator('table').first();
  await page.getByRole('searchbox', { name: 'Search comedians' }).fill(run);
  await expect(roster.locator('tbody tr')).toHaveCount(3);
  for (const comic of [ana, ben, cal]) await expect(roster.getByRole('link', { name: comic.name })).toBeVisible();
  // Each was emailed a sign-in link (outbox mode).
  await expect.poll(() => loginLinkEmailsTo([ana.email, ben.email, cal.email])).toEqual([ana.email, ben.email, cal.email].sort());

  // The note became a private booker note on Ana's profile.
  await roster.getByRole('link', { name: ana.name }).click();
  await expect(page.getByRole('heading', { name: ana.name })).toBeVisible();
  await expect(page.getByText(ana.note)).toBeVisible();

  // Ben's phone shows on his profile as a tap-to-call link.
  await page.goto('/app/comedians');
  await page.getByRole('searchbox', { name: 'Search comedians' }).fill('555-0142');
  await page.locator('table').first().getByRole('link', { name: ben.name }).click();
  await expect(page.getByRole('heading', { name: ben.name })).toBeVisible();
  const call = page.getByRole('link', { name: ben.phone });
  await expect(call).toBeVisible();
  await expect(call).toHaveAttribute('href', 'tel:2125550142');

  // Maria was left alone (no phone added, no note from the file).
  const maria = new Database(DB_FILE, { readonly: true });
  try {
    expect(maria.prepare('SELECT COUNT(*) AS n FROM comedians WHERE email = ?').get(EXISTING.email)).toEqual({ n: 1 });
    expect(maria.prepare('SELECT COUNT(*) AS n FROM comedians WHERE email LIKE ?').get(`%.${run}@example.com`)).toEqual({ n: 3 });
  } finally {
    maria.close();
  }
});

test('Import CSV explains files it cannot use', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop flow');
  await signInAsAdmin(page);
  await page.goto('/app/comedians');
  await page.locator('[data-guide="comedians-import"]').click();
  const dialog = page.getByRole('dialog', { name: 'Import comedians from a CSV' });

  await dialog.getByLabel('CSV file').setInputFiles({
    name: 'Roster.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
  });
  await expect(dialog.getByRole('alert')).toContainText('Roster.xlsx is a spreadsheet file, not a CSV');

  const tooMany = ['Name,Email', ...Array.from({ length: 1001 }, (_, i) => `Comic ${i},comic${i}@example.test`)].join('\n');
  await dialog.getByLabel('CSV file').setInputFiles({ name: 'huge.csv', mimeType: 'text/csv', buffer: Buffer.from(tooMany) });
  await expect(dialog.getByRole('alert')).toContainText('huge.csv has 1,001 rows. Import at most 1,000 at a time');
  await expect(dialog.getByTestId('csv-preview')).toHaveCount(0);
});
