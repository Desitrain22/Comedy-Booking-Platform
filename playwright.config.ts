import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

// `npm run e2e` starts its own isolated servers on non-default ports, so it never touches your
// dev data or clashes with `npm run dev`:
//
//   seeded      .data/e2e              API 3999 · Vite 5999   `npm run seed` first (the demo club)
//   fresh       .data/e2e-fresh        API 3998 · Vite 5998   no seed: e2e/onboarding.spec.ts
//   first-month .data/e2e-first-month  API 3997 · Vite 5997   no seed: e2e/first-month.spec.ts
//
// The fresh servers start with an empty data folder (wiped before every run), so their specs
// go through /setup like a new club. Each spec that runs /setup gets its own server: a club can
// only be set up once.
//
// To run against a server you already started instead (no seeding, no webServer):
//   E2E_BASE_URL=http://localhost:5990 E2E_DATA_DIR=.data/foundation npx playwright test --project=desktop
// E2E_DATA_DIR tells specs where club.db lives (they read sign-in codes from email_log). The
// fresh projects need a fresh, unseeded server of their own (see e2e/onboarding.spec.ts).
const externalBaseUrl = process.env.E2E_BASE_URL;

interface Server {
  port: number;
  vitePort: number;
  dataDir: string;
  /** Seed the demo club first (otherwise: start from an empty data folder). */
  seed: boolean;
}

const SEEDED: Server = { port: 3999, vitePort: 5999, dataDir: '.data/e2e', seed: true };
const FRESH: Server = { port: 3998, vitePort: 5998, dataDir: '.data/e2e-fresh', seed: false };
const FIRST_MONTH: Server = { port: 3997, vitePort: 5997, dataDir: '.data/e2e-first-month', seed: false };

const FRESH_SPECS = { fresh: /onboarding\.spec\.ts/, firstMonth: /first-month\.spec\.ts/ };

const baseUrl = (server: Server) => externalBaseUrl ?? `http://localhost:${server.vitePort}`;

/** What every spec reads from `testInfo.project.metadata` (see e2e/db.ts). */
const metadata = (server: Server) => ({ dataDir: process.env.E2E_DATA_DIR ?? server.dataDir });

/** Wipe the data folder (portable `rm -rf`), then run the app. */
function startCommand(server: Server): string {
  if (server.seed) return 'npm run seed && npm run dev';
  const wipe = `require('node:fs').rmSync(${JSON.stringify(server.dataDir)}, { recursive: true, force: true })`;
  return `node -e ${JSON.stringify(wipe)} && npm run dev`;
}

type WebServer = Exclude<NonNullable<PlaywrightTestConfig['webServer']>, readonly unknown[]>;

function webServer(server: Server): WebServer {
  return {
    command: startCommand(server),
    // Through Vite's /api proxy, so both the API and the dev server are up.
    url: `http://localhost:${server.vitePort}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATA_DIR: server.dataDir,
      PORT: String(server.port),
      VITE_PORT: String(server.vitePort),
      APP_URL: `http://localhost:${server.vitePort}`,
    },
  };
}

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], baseURL: baseUrl(SEEDED) },
      metadata: metadata(SEEDED),
      testIgnore: [FRESH_SPECS.fresh, FRESH_SPECS.firstMonth],
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], baseURL: baseUrl(SEEDED) },
      metadata: metadata(SEEDED),
      testMatch: /portal.*\.spec\.ts/,
    },
    // A new club, no seed: the setup guide, skip/resume, and the welcome tour for an invited booker.
    {
      name: 'fresh',
      use: { ...devices['Desktop Chrome'], baseURL: baseUrl(FRESH) },
      metadata: metadata(FRESH),
      testMatch: FRESH_SPECS.fresh,
    },
    // A new club's first month, start to finish: /setup → shows → CSV import → availability → a comedian.
    {
      name: 'first-month',
      use: { ...devices['Desktop Chrome'], baseURL: baseUrl(FIRST_MONTH) },
      metadata: metadata(FIRST_MONTH),
      testMatch: FRESH_SPECS.firstMonth,
    },
  ],
  webServer: externalBaseUrl ? undefined : [SEEDED, FRESH, FIRST_MONTH].map(webServer),
});
