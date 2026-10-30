/**
 * Setup guide (onboarding) + welcome tour API contract (onboarding design §2).
 *
 *   GET  /api/onboarding            OnboardingResponse (for the signed-in booker)
 *   POST /api/onboarding/dismiss    → OnboardingResponse   "Skip guide": never auto-starts again until resumed
 *   POST /api/onboarding/resume     → OnboardingResponse   clears the skip (user menu / Getting started)
 *   POST /api/onboarding/complete   → OnboardingResponse   finished (or the tour was skipped): never auto-starts again
 *
 * All booker-only, per booker (`users.guideDismissedAt` / `users.guideCompletedAt`).
 *
 * Step completion is derived from club data, never from clicks:
 * - **club**: setup is complete and the club has an active location.
 * - **shows**: at least `SHOWS_TARGET` scheduled shows exist.
 * - **comedians**: at least one non-archived comedian exists AND an availability request (or
 *   reminder) went out for a month that has scheduled shows.
 *
 * Mode (who gets which guide):
 * - `setup` — an admin who is the club's founding booker (the account /setup created: the
 *   lowest user id), or any admin while the shows or comedians step isn't done yet.
 * - `tour` — everyone else: bookers, and admins who join a club that is already set up. They
 *   get the short, task-free welcome tour over the nav instead.
 */

export const ONBOARDING_STEP_KEYS = ['club', 'shows', 'comedians'] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

export type OnboardingStepStatus = 'done' | 'current' | 'todo';

export type GuideMode = 'setup' | 'tour';

/** Scheduled shows that complete the shows step. */
export const SHOWS_TARGET = 3;

export interface OnboardingProgress {
  count: number;
  target: number;
}

export interface OnboardingStep {
  key: OnboardingStepKey;
  /** `current` is the first step that isn't done; later unfinished steps are `todo`. */
  status: OnboardingStepStatus;
  /** Shows: `{ count: scheduled shows, target: SHOWS_TARGET }`. */
  progress?: OnboardingProgress;
}

export interface OnboardingCounts {
  /** Active (non-archived) locations. */
  locations: number;
  /** Scheduled shows (any date). */
  scheduledShows: number;
  /** Non-archived comedians. */
  comedians: number;
  /** Booker accounts, including pending invites (the "invite another booker" extra). */
  bookers: number;
}

/** `GET /api/onboarding` and the POST actions. */
export interface OnboardingResponse {
  /** club → shows → comedians. */
  steps: OnboardingStep[];
  /** The first step that isn't done; null once all three are. */
  currentStep: OnboardingStepKey | null;
  /** When this booker finished the guide or tour (it never auto-starts again). */
  completedAt: number | null;
  /** When this booker skipped the guide (null = not skipped, or resumed since). */
  dismissedAt: number | null;
  /** False → emails wait in the outbox. */
  emailConfigured: boolean;
  /**
   * The month to ask availability for: the planning month when it has scheduled shows, else
   * the upcoming month (this month or later) with the most scheduled shows, else the planning
   * month. Also where the guide's create-shows step opens.
   */
  suggestedMonth: string;
  mode: GuideMode;
  counts: OnboardingCounts;
  /** An availability request or reminder went out for a month that has scheduled shows. */
  availabilityRequested: boolean;
}
