import { defineConfig } from 'drizzle-kit';

/** Hosted mode's platform registry (`npm run db:generate:platform`). The club schema is drizzle.config.ts. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './server/platform/schema.ts',
  out: './server/platform/migrations',
  dbCredentials: { url: `${process.env.DATA_DIR ?? './.data'}/platform.db` },
});
