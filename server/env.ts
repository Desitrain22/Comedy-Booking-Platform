/**
 * Process environment, read once at startup. Only infrastructure lives here; club
 * configuration (SMTP, timezone, app URL…) lives in the `settings` table and these
 * values are only fallbacks.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

// Load ./.env for local runs. Real environment variables always win.
if (!process.env.VITEST && existsSync('.env')) process.loadEnvFile('.env');

export interface SmtpEnv {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
}

export interface Env {
  port: number;
  dataDir: string;
  /** Absolute path of the SQLite file: `$DATA_DIR/club.db`. */
  dbFile: string;
  /** Fallback for settings.appUrl (links in emails), no trailing slash. */
  appUrl: string | null;
  isProduction: boolean;
  isTest: boolean;
  /** SMTP fallback used when Settings → Email has no host. */
  smtp: SmtpEnv | null;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isInteger(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const dataDir = path.resolve(source.DATA_DIR || './.data');
  const smtpHost = source.SMTP_HOST?.trim();
  const smtpPort = int(source.SMTP_PORT, 587);
  return {
    port: int(source.PORT, 3000),
    dataDir,
    dbFile: path.join(dataDir, 'club.db'),
    appUrl: source.APP_URL ? source.APP_URL.replace(/\/+$/, '') : null,
    // The tsup bundle inlines process.env.NODE_ENV = 'production', so `npm start` is production.
    isProduction: source.NODE_ENV === 'production' || process.env.NODE_ENV === 'production',
    isTest: Boolean(source.VITEST) || source.NODE_ENV === 'test',
    smtp: smtpHost
      ? {
          host: smtpHost,
          port: smtpPort,
          secure: bool(source.SMTP_SECURE, smtpPort === 465),
          user: source.SMTP_USER ?? '',
          pass: source.SMTP_PASS ?? '',
          fromEmail: source.SMTP_FROM_EMAIL ?? source.SMTP_USER ?? '',
          fromName: source.SMTP_FROM_NAME ?? '',
          replyTo: source.SMTP_REPLY_TO ?? '',
        }
      : null,
  };
}

export const env = readEnv();
