import { cpSync, rmSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'server/index.ts', seed: 'server/db/seed.ts' },
  outDir: 'dist/server',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  // Bundled code always runs in production mode (serves dist/client).
  env: { NODE_ENV: 'production' },
  external: ['better-sqlite3'],
  async onSuccess() {
    // createDb() resolves migrations relative to the bundle: dist/server/migrations.
    rmSync('dist/server/migrations', { recursive: true, force: true });
    cpSync('server/db/migrations', 'dist/server/migrations', { recursive: true });
    // createPlatformDb() (hosted mode): dist/server/platform-migrations.
    rmSync('dist/server/platform-migrations', { recursive: true, force: true });
    cpSync('server/platform/migrations', 'dist/server/platform-migrations', { recursive: true });
  },
});
