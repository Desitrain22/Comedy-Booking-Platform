/**
 * Hosted mode: host context, sign-up and "find my club" (hosted MVP spec §3–4).
 *
 *   GET  /api/host                          HostContext (any host, any visitor; never 403s)
 *
 * Platform host only (`<domain>` / `www.<domain>`; 404 `not_found` elsewhere):
 *   GET  /api/platform/slug?slug=…          SlugCheckResponse
 *   POST /api/platform/signup               SignupRequest → SignupResponse (rate-limited per IP)
 *   POST /api/platform/find-club            FindClubRequest → OkResponse (always ok; emails a list)
 *
 * Club host only (`<slug>.<domain>`):
 *   POST /api/auth/handoff                  HandoffRequest → { ok: true } + booker session cookie
 *
 * The owner console (`/api/platform/admin/*`) has its own contract: shared/api/platformAdmin.ts.
 */
import { z } from 'zod';
import { emailSchema } from '../schemas';

/** What the SPA should render on this host. */
export type HostContext =
  /** Self-hosted single club (no PLATFORM_URL): the app as it has always been. */
  | { mode: 'single' }
  /** The platform site: landing, sign-up, find-my-club, owner console. */
  | { mode: 'platform'; platformName: string; platformUrl: string; signupsOpen: boolean; supportEmail: string }
  /**
   * A club's subdomain. `active` renders the normal app; `suspended` renders the paused page
   * (every other club API call answers 403 `club_suspended`). Unknown or archived clubs get
   * a 404 `club_not_found` from /api/host instead (the SPA renders "no club at this address").
   */
  | {
      mode: 'club';
      status: 'active' | 'suspended';
      clubName: string;
      platformName: string;
      platformUrl: string;
      supportEmail: string;
    };

export const SLUG_MIN = 3;
export const SLUG_MAX = 30;

/** Subdomains a club can never take. */
export const RESERVED_SLUGS: readonly string[] = [
  'www', 'admin', 'app', 'api', 'mail', 'smtp', 'imap', 'pop', 'mx', 'email', 'support', 'help',
  'status', 'blog', 'docs', 'static', 'assets', 'cdn', 'platform', 'signup', 'signin', 'login',
  'dev', 'staging', 'test', 'demo', 'billing', 'account', 'accounts', 'dashboard', 'portal',
  'send', 'bounce', 'ftp', 'ns1', 'ns2', 'root', 'owner', 'security',
];

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(SLUG_MIN, `At least ${SLUG_MIN} characters`)
  .max(SLUG_MAX, `At most ${SLUG_MAX} characters`)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use letters, numbers and dashes (not at the start or end)')
  .refine((s) => !RESERVED_SLUGS.includes(s), 'That address is reserved');

/** Suggest a slug from a company name: "Broadway Comedy Club!" → "broadway-comedy-club". */
export function suggestSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export interface SlugCheckResponse {
  slug: string;
  available: boolean;
  /** Why not (invalid / reserved / taken), when unavailable. */
  reason?: string;
}

export const signupSchema = z.object({
  clubName: z.string().trim().min(1).max(120),
  slug: slugSchema,
  timezone: z.string().trim().min(1).max(64),
  location: z.object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).default(''),
  }),
  admin: z.object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    password: z.string().min(8).max(200),
  }),
  /** Honeypot: humans leave it empty. */
  website: z.string().max(200).optional(),
});
export type SignupRequest = z.input<typeof signupSchema>;

export interface SignupResponse {
  /** https://<slug>.<domain> */
  clubUrl: string;
  /** `${clubUrl}/welcome#<token>`: open it to land signed in on the club host. */
  handoffUrl: string;
}

export const handoffSchema = z.object({ token: z.string().min(16).max(200) });
export type HandoffRequest = z.infer<typeof handoffSchema>;

export const findClubSchema = z.object({ email: emailSchema });
export type FindClubRequest = z.infer<typeof findClubSchema>;
