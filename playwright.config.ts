import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

// `npm run e2e` starts its own isolated servers on non-default ports, so it never touches your
// dev data or clashes with `npm run dev`:
//
//   seeded      .data/e2e              API 3999 · Vite 5999   `npm run seed` first (the demo club)
//   fresh       .data/e2e-fresh        API 3998 · Vite 5998   no seed: e2e/onboarding.spec.ts
//   first-month .data/e2e-first-month  API 3997 · Vite 5997   no seed: e2e/first-month.spec.ts
//   hosted      .data/e2e-hosted       API 3996 · Vite 5996   hosted mode (PLATFORM_URL): e2e/hosted*.spec.ts
//
// The fresh servers start with an empty data folder (wiped before every run), so their specs
// go through /setup like a new club. Each spec that runs /setup gets its own server: a club can
// only be set up once. The hosted server is many clubs on one server: the platform site at
// http://localhost:5996 and each club at http://<slug>.localhost:5996.
//
// `--project <name>` starts only the servers those projects use (all of them otherwise).
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
  /** Hosted mode: extra environment (PLATFORM_URL…). */
  env?: Record<string, string>;
}

const SEEDED: Server = { port: 3999, vitePort: 5999, dataDir: '.data/e2e', seed: true };
const FRESH: Server = { port: 3998, vitePort: 5998, dataDir: '.data/e2e-fresh', seed: false };
const FIRST_MONTH: Server = { port: 3997, vitePort: 5997, dataDir: '.data/e2e-first-month', seed: false };
const HOSTED: Server = {
  port: 3996,
  vitePort: 5996,
  dataDir: '.data/e2e-hosted',
  seed: false,
  env: {
    PLATFORM_URL: 'http://localhost:5996',
    PLATFORM_NAME: 'Comedy Booking',
    PLATFORM_ADMIN_EMAILS: 'owner@hosted.example',
    SUPPORT_EMAIL: 'help@hosted.example',
  },
};

const FRESH_SPECS = { fresh: /onboarding\.spec\.ts/, firstMonth: /first-month\.spec\.ts/, hosted: /hosted.*\.spec\.ts/ };

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
      ...server.env,
    },
  };
}

/** The servers each project needs. */
const PROJECT_SERVERS: Record<string, Server> = {
  desktop: SEEDED,
  mobile: SEEDED,
  fresh: FRESH,
  'first-month': FIRST_MONTH,
  hosted: HOSTED,
};

/** Projects named with `--project` on the command line (empty: all of them). */
function selectedProjects(argv = process.argv): string[] {
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--project' && argv[i + 1]) names.push(argv[++i]!);
    else if (arg.startsWith('--project=')) names.push(arg.slice('--project='.length));
  }
  return names;
}

/** Only the servers the selected projects use, so one project's run never starts the others'. */
function serversToStart(): Server[] {
  const selected = selectedProjects();
  const all = [SEEDED, FRESH, FIRST_MONTH, HOSTED];
  if (!selected.length) return all;
  const wanted = new Set(selected.map((name) => PROJECT_SERVERS[name]).filter(Boolean));
  return all.filter((server) => wanted.has(server));
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
      testIgnore: [FRESH_SPECS.fresh, FRESH_SPECS.firstMonth, FRESH_SPECS.hosted],
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
    // Hosted mode: sign-up → the guide on the club's own address, a second club stays isolated,
    // an unknown address, a suspended club.
    {
      name: 'hosted',
      use: { ...devices['Desktop Chrome'], baseURL: baseUrl(HOSTED) },
      metadata: metadata(HOSTED),
      testMatch: FRESH_SPECS.hosted,
    },
  ],
  webServer: externalBaseUrl ? undefined : serversToStart().map(webServer),
});
