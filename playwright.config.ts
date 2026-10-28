import { defineConfig, devices } from '@playwright/test';

// The e2e suite runs against a freshly seeded, isolated database on non-default
// ports so it never touches your dev data or clashes with `npm run dev`.
//
// To run against a server you already started instead (no seeding, no webServer):
//   E2E_BASE_URL=http://localhost:5990 E2E_DATA_DIR=.data/foundation npx playwright test
// E2E_DATA_DIR tells specs where club.db lives (they read sign-in codes from email_log).
const PORT = 3999;
const VITE_PORT = 5999;
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${VITE_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /portal.*\.spec\.ts/ },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'npm run seed && npm run dev',
        // Through Vite's /api proxy, so both the API and the dev server are up.
        url: `http://localhost:${VITE_PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          DATA_DIR: '.data/e2e',
          PORT: String(PORT),
          VITE_PORT: String(VITE_PORT),
          APP_URL: `http://localhost:${VITE_PORT}`,
        },
      },
});
