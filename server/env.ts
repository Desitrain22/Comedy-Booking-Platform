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

/**
 * Hosted mode (hosted MVP spec §3): set when PLATFORM_URL is. One server, many clubs, each
 * at `<protocol>//<slug>.<platformHost>`; the platform site (sign-up, owner console) at
 * `platformUrl`.
 */
export interface HostedEnv {
  /** e.g. `https://comedybook.app` or `http://localhost:3000` (no trailing slash, no path). */
  platformUrl: string;
  /** Lowercased host of platformUrl, with the port when there is one: `comedybook.app`, `localhost:3000`. */
  platformHost: string;
  protocol: 'http:' | 'https:';
  /** PLATFORM_NAME: shown on the platform site and platform emails. */
  platformName: string;
  /** PLATFORM_ADMIN_EMAILS (comma-separated, lowercased): who may sign in to the owner console. */
  adminEmails: string[];
  /** SUPPORT_EMAIL (default: the first admin email): shown on paused / sign-ups-closed pages. */
  supportEmail: string;
  /** SIGNUPS=open (default) | closed. */
  signupsOpen: boolean;
  /** PLATFORM_DAILY_EMAIL_CAP: platform-sender emails per club per club-local day (default 2000). */
  dailyEmailCap: number;
}

export interface Env {
  port: number;
  dataDir: string;
  /** Absolute path of the SQLite file: `$DATA_DIR/club.db` (single-club mode). */
  dbFile: string;
  /** Hosted mode: `$DATA_DIR/platform.db`. */
  platformDbFile: string;
  /** Hosted mode: `$DATA_DIR/clubs` (one `<clubId>.db` per club). */
  clubsDir: string;
  /** Hosted mode: `$DATA_DIR/backups` (nightly copies, `<YYYY-MM-DD>/`). */
  backupsDir: string;
  /** Hosted mode settings; null = single-club mode (the self-hosted install). */
  hosted: HostedEnv | null;
  /**
   * APP_SECRET: encrypts mailbox passwords at rest (spec §5). Required in hosted mode in
   * production; optional (plaintext as before) for a self-hosted single club.
   */
  appSecret: string | null;
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

function readHosted(source: NodeJS.ProcessEnv): HostedEnv | null {
  const raw = source.PLATFORM_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PLATFORM_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('PLATFORM_URL must be http(s)');
  const adminEmails = (source.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return {
    platformUrl: url.origin,
    platformHost: url.host.toLowerCase(),
    protocol: url.protocol,
    platformName: source.PLATFORM_NAME?.trim() || 'Comedy Booking',
    adminEmails,
    supportEmail: source.SUPPORT_EMAIL?.trim() || adminEmails[0] || '',
    signupsOpen: (source.SIGNUPS?.trim().toLowerCase() || 'open') !== 'closed',
    dailyEmailCap: int(source.PLATFORM_DAILY_EMAIL_CAP, 2000),
  };
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const dataDir = path.resolve(source.DATA_DIR || './.data');
  const smtpHost = source.SMTP_HOST?.trim();
  const smtpPort = int(source.SMTP_PORT, 587);
  return {
    port: int(source.PORT, 3000),
    dataDir,
    dbFile: path.join(dataDir, 'club.db'),
    platformDbFile: path.join(dataDir, 'platform.db'),
    clubsDir: path.join(dataDir, 'clubs'),
    backupsDir: path.join(dataDir, 'backups'),
    hosted: readHosted(source),
    appSecret: source.APP_SECRET?.trim() || null,
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
