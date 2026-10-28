import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/**/*.test.{ts,tsx}'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15_000,
    env: {
      // Keep password hashing fast in tests.
      BCRYPT_ROUNDS: '4',
    },
  },
});
