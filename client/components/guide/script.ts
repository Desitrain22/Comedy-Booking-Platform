/**
 * The setup guide's script (onboarding design §2) as a pure function: given the onboarding
 * data, where the booker is, what the page reports (e.g. dates picked on Create shows) and the
 * guide's small local state, which coach mark to show. Unit-tested in script.test.ts.
 *
 * The guide waits for the real thing: step completion comes from club data (`GET
 * /api/onboarding`), and only informational marks have a Next button.
 *
 *   setup:  Shows   form → days → create → (more) → "N shows on the calendar" → Next
 *           Comedians  import/add → "N on the roster" → Next → dashboard: request availability
 *           → "You're set up" → Done
 *   tour:   nav-dashboard → nav-calendar → nav-comedians → nav-settings → Done
 */
import { SHOWS_TARGET, type OnboardingResponse, type OnboardingStepKey } from '../../../shared/api/onboarding';
import { formatMonthName } from '../../../shared/time';
import type { Side } from './placement';

export type MarkId =
  | 'club-location'
  | 'club-goto'
  | 'shows-form'
  | 'shows-days'
  | 'shows-create'
  | 'shows-more'
  | 'shows-done'
  | 'shows-goto'
  | 'comedians-add'
  | 'comedians-done'
  | 'comedians-goto'
  | 'request'
  | 'request-email'
  | 'request-goto'
  | 'finish'
  | 'tour-dashboard'
  | 'tour-calendar'
  | 'tour-comedians'
  | 'tour-settings';

/** Things a page can do when the coach card asks (registered with `useGuideAction`). */
export type GuidePageAction = 'request-availability';

/** The guide's own state that isn't club data (kept per tab in sessionStorage). */
export interface LocalGuideState {
  /** Create shows, before the first show exists: 0 form → 1 days → 2 create. */
  showsCursor: 0 | 1 | 2;
  /** "N shows on the calendar" was acknowledged with Next. */
  ackShows: boolean;
  /** "N comedians on the roster" was acknowledged with Next. */
  ackComedians: boolean;
  /** Welcome tour position (0–3). */
  tourIndex: number;
}

export const INITIAL_LOCAL_STATE: LocalGuideState = { showsCursor: 0, ackShows: false, ackComedians: false, tourIndex: 0 };

export type GuideCommand =
  | { type: 'local'; patch: Partial<LocalGuideState> }
  | { type: 'navigate'; to: string; patch?: Partial<LocalGuideState> }
  | { type: 'page-action'; name: GuidePageAction }
  | { type: 'complete' };

export interface GuideButton {
  label: string;
  command: GuideCommand;
}

export interface GuideMark {
  id: MarkId;
  /** Small line above the title: "Step 2 of 3 · Shows". */
  kicker: string;
  title: string;
  body: string;
  /** A plainly worded caveat (e.g. emails will wait in the outbox). */
  note?: string;
  /** "What happens next" bullets (the finish card). */
  list?: string[];
  /** `data-guide` ids to light, in order; the first is where the card sits (see `anchor`). */
  targets: string[];
  /** Sides to try first when placing the card next to the target. */
  placement?: Side[];
  /** Place the card against all targets together (adjacent buttons) instead of the first. */
  anchor?: 'first' | 'union';
  /** Without targets: centered (with the dim) or docked top-right, undimmed (a form underneath). */
  dock?: 'center' | 'corner';
  primary?: GuideButton;
  secondary?: GuideButton;
  back?: GuideCommand;
  /** Action steps (no Next): what the guide is waiting for, shown where Next would be. */
  waiting?: string;
  /** Shown above an open dialog (the card hides behind dialogs). */
  dialogHint?: string;
  /** Skip guide / Skip tour (the finish card has none). */
  skipLabel?: string;
  /** For the minimized pill: "Step 2 of 3" / "2 of 4". */
  progressLabel: string;
}

export interface GuideInput {
  data: OnboardingResponse;
  pathname: string;
  isAdmin: boolean;
  local: LocalGuideState;
  /** Shows the create-shows page would create right now (0 = nothing picked). */
  showsSelected: number;
  /** Show the "You're set up" card (the guide saw the last step finish). */
  finishing: boolean;
}

export const STEP_LABELS: Record<OnboardingStepKey, string> = { club: 'Club', shows: 'Shows', comedians: 'Comedians' };
const STEP_NUMBER: Record<OnboardingStepKey, number> = { club: 1, shows: 2, comedians: 3 };

export const CREATE_SHOWS_PATH = '/app/shows/new';
export const COMEDIANS_PATH = '/app/comedians';
export const DASHBOARD_PATH = '/app';
export const EMAIL_SETTINGS_PATH = '/app/settings/email';
export const LOCATIONS_SETTINGS_PATH = '/app/settings/locations';

export function createShowsPath(month: string): string {
  return `${CREATE_SHOWS_PATH}?month=${month}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function samePath(pathname: string, path: string): boolean {
  return pathname === path || pathname === `${path}/`;
}

const SKIP_GUIDE = 'Skip guide';

function stepKicker(key: OnboardingStepKey): string {
  return `Step ${STEP_NUMBER[key]} of 3 · ${STEP_LABELS[key]}`;
}

function stepProgress(key: OnboardingStepKey): string {
  return `Step ${STEP_NUMBER[key]} of 3`;
}

// ---------------------------------------------------------------------------
// Welcome tour (invited bookers)
// ---------------------------------------------------------------------------

export const TOUR_LENGTH = 4;

const TOUR: { id: MarkId; target: string; title: string; body: string }[] = [
  {
    id: 'tour-dashboard',
    target: 'nav-dashboard',
    title: 'Your dashboard',
    body: "Tonight at a glance: who still has to confirm, this week's shows, and who has sent their availability.",
  },
  {
    id: 'tour-calendar',
    target: 'nav-calendar',
    title: 'The calendar',
    body: 'Every show, month by month. Click a day to build its lineups: drag comedians into the slots.',
  },
  {
    id: 'tour-comedians',
    target: 'nav-comedians',
    title: 'Your comedians',
    body: 'The roster, with private notes and tags that only bookers see. Hover a name anywhere to read them.',
  },
  {
    id: 'tour-settings',
    target: 'nav-settings',
    title: 'Settings',
    body: "Locations, weekly confirmation emails and your account. That's the tour. Happy booking!",
  },
];

function tourMark(index: number): GuideMark {
  const i = Math.min(Math.max(index, 0), TOUR.length - 1);
  const stop = TOUR[i]!;
  const last = i === TOUR.length - 1;
  return {
    id: stop.id,
    kicker: `Welcome tour · ${i + 1} of ${TOUR.length}`,
    title: stop.title,
    body: stop.body,
    targets: [stop.target],
    placement: ['right', 'bottom'],
    primary: last
      ? { label: 'Done', command: { type: 'complete' } }
      : { label: 'Next', command: { type: 'local', patch: { tourIndex: i + 1 } } },
    back: i > 0 ? { type: 'local', patch: { tourIndex: i - 1 } } : undefined,
    skipLabel: last ? undefined : 'Skip tour',
    progressLabel: `${i + 1} of ${TOUR.length}`,
  };
}

// ---------------------------------------------------------------------------
// Setup guide
// ---------------------------------------------------------------------------

function finishMark(data: OnboardingResponse): GuideMark {
  return {
    id: 'finish',
    kicker: 'Setup guide · All 3 steps done',
    title: 'You’re set up',
    body: "Your comedians have been asked for their nights. Here's what happens next:",
    list: [
      'Comedians mark the nights they’re free from the link in their email.',
      'You’ll see who has answered on the dashboard.',
      'Then open any day on the calendar and drag comedians into its lineups.',
    ],
    note: data.emailConfigured
      ? undefined
      : 'Email isn’t connected yet, so those emails are waiting in the outbox. Connect it in Settings → Email to send them.',
    targets: [],
    dock: 'center',
    primary: { label: 'Done', command: { type: 'complete' } },
    progressLabel: 'All set',
  };
}

function clubMark(pathname: string): GuideMark {
  const base = { kicker: stepKicker('club'), skipLabel: SKIP_GUIDE, progressLabel: stepProgress('club') };
  if (samePath(pathname, LOCATIONS_SETTINGS_PATH)) {
    return {
      ...base,
      id: 'club-location',
      title: 'Add your first location',
      body: 'The room or venue your shows happen in (and its address, for confirmation emails). The guide picks up as soon as it’s saved.',
      targets: [],
      dock: 'corner',
      waiting: 'Waiting for a location',
    };
  }
  return {
    ...base,
    id: 'club-goto',
    title: 'Add a location',
    body: 'Shows happen in a room or venue. Add one in Settings, then come back to put shows on the calendar.',
    targets: ['nav-settings'],
    placement: ['right'],
    primary: { label: 'Open locations', command: { type: 'navigate', to: LOCATIONS_SETTINGS_PATH } },
  };
}

function showsMark(input: GuideInput): GuideMark {
  const { data, pathname, local, showsSelected } = input;
  const count = data.counts.scheduledShows;
  const base = { kicker: stepKicker('shows'), skipLabel: SKIP_GUIDE, progressLabel: stepProgress('shows') };

  if (!samePath(pathname, CREATE_SHOWS_PATH)) {
    return {
      ...base,
      id: 'shows-goto',
      title: count ? `${plural(count, 'show')} so far` : 'Put a few shows on the calendar',
      body: count
        ? `Add ${plural(SHOWS_TARGET - count, 'more show')} to finish this step. Pick a room and a time, then tap a weekday.`
        : 'Pick a room and a time, then tap a weekday to fill the month in one go.',
      targets: ['nav-calendar'],
      placement: ['right'],
      primary: { label: 'Create shows', command: { type: 'navigate', to: createShowsPath(data.suggestedMonth) } },
    };
  }

  const createMark = (): GuideMark => ({
    ...base,
    id: 'shows-create',
    title: `${plural(showsSelected, 'show')} ready`,
    body: count
      ? 'Create them. We’ll move on once there are at least 3 on the calendar.'
      : 'Create them. The confirmation lets you undo if something’s off.',
    targets: ['shows-create'],
    placement: ['right', 'bottom', 'top'],
    back: count ? undefined : { type: 'local', patch: { showsCursor: 1 } },
    waiting: 'Waiting for Create',
  });

  if (count > 0) {
    if (showsSelected > 0) return createMark();
    return {
      ...base,
      id: 'shows-more',
      title: `${plural(count, 'show')} on the calendar`,
      body: `Add a couple more, maybe a Saturday 7 and 9? Change the start time, pick the days, and create again. We’ll move on at ${SHOWS_TARGET}.`,
      targets: ['shows-form', 'shows-weekdays'],
      placement: ['right', 'bottom'],
      waiting: 'Waiting for more shows',
    };
  }

  if (local.showsCursor === 0 && showsSelected === 0) {
    return {
      ...base,
      id: 'shows-form',
      title: 'Your first show',
      body: 'Pick the room and the start time. Most clubs start with their regular weekend shows.',
      targets: ['shows-form'],
      placement: ['right', 'bottom'],
      primary: { label: 'Next', command: { type: 'local', patch: { showsCursor: 1 } } },
    };
  }
  if (local.showsCursor === 2 && showsSelected > 0) return createMark();
  return {
    ...base,
    id: 'shows-days',
    title: 'Put it on the calendar',
    body: 'Tap F to add this show to every Friday this month, or drag across days on the calendar.',
    targets: ['shows-weekdays', 'shows-calendar'],
    placement: ['left', 'bottom', 'right'],
    back: { type: 'local', patch: { showsCursor: 0 } },
    // Informational once dates are picked (e.g. after Back from "Create them").
    primary: showsSelected > 0 ? { label: 'Next', command: { type: 'local', patch: { showsCursor: 2 } } } : undefined,
    waiting: showsSelected > 0 ? undefined : 'Waiting for dates',
  };
}

function comediansMark(input: GuideInput): GuideMark {
  const { data, pathname, local, isAdmin } = input;
  const roster = data.counts.comedians;
  const month = formatMonthName(data.suggestedMonth);
  const base = { kicker: stepKicker('comedians'), skipLabel: SKIP_GUIDE, progressLabel: stepProgress('comedians') };
  const onComedians = samePath(pathname, COMEDIANS_PATH);

  if (roster === 0) {
    if (onComedians) {
      return {
        ...base,
        id: 'comedians-add',
        title: 'Add your comedians',
        body: 'Import your spreadsheet, or add them one at a time. A name and an email each is all it takes.',
        targets: ['comedians-import', 'comedians-add'],
        anchor: 'union',
        placement: ['bottom', 'left'],
        back: { type: 'navigate', to: createShowsPath(data.suggestedMonth), patch: { ackShows: false } },
        waiting: 'Waiting for your first comedian',
        dialogHint: 'Setup guide: we’ll carry on as soon as they’re on the roster.',
      };
    }
    return {
      ...base,
      id: 'comedians-goto',
      title: 'Next: your comedians',
      body: 'Import your spreadsheet, or add them one at a time.',
      targets: ['nav-comedians'],
      placement: ['right'],
      primary: { label: 'Go to Comedians', command: { type: 'navigate', to: COMEDIANS_PATH } },
    };
  }

  if (onComedians && !local.ackComedians) {
    return {
      ...base,
      id: 'comedians-done',
      title: `${plural(roster, 'comedian')} on the roster`,
      body: 'Add more any time. Next, ask them which nights they’re free.',
      targets: ['comedians-import', 'comedians-add'],
      anchor: 'union',
      placement: ['bottom', 'left'],
      primary: { label: 'Next', command: { type: 'navigate', to: DASHBOARD_PATH, patch: { ackComedians: true } } },
      dialogHint: 'Setup guide: add as many as you like, then hit Next.',
    };
  }

  if (samePath(pathname, DASHBOARD_PATH)) {
    const request: GuideButton = {
      label: data.emailConfigured ? 'Request availability' : 'Send anyway',
      command: { type: 'page-action', name: 'request-availability' },
    };
    return {
      ...base,
      id: 'request',
      title: 'Ask who’s free',
      body: `Send your comedians the ${month} availability request. Each gets a link to mark the nights they can do.`,
      note: data.emailConfigured
        ? undefined
        : 'Email isn’t connected yet, so the requests will wait in the outbox until it is.',
      targets: ['dashboard-request-availability'],
      placement: ['left', 'bottom', 'top'],
      primary: request,
      secondary:
        !data.emailConfigured && isAdmin
          ? { label: 'Connect email', command: { type: 'navigate', to: EMAIL_SETTINGS_PATH } }
          : undefined,
      back: { type: 'navigate', to: COMEDIANS_PATH, patch: { ackComedians: false } },
      dialogHint: `Setup guide: check it’s ${month} and Everyone, then hit Send.`,
    };
  }

  if (isAdmin && samePath(pathname, EMAIL_SETTINGS_PATH)) {
    return {
      ...base,
      id: 'request-email',
      title: data.emailConfigured ? 'Email is connected' : 'Connect your email',
      body: data.emailConfigured
        ? `Requests now go straight to inboxes. Head back to send the ${month} request.`
        : 'Pick your provider, fill in the details and save. Then head back to send the request.',
      targets: [],
      dock: 'corner',
      primary: { label: 'Back to the guide', command: { type: 'navigate', to: DASHBOARD_PATH } },
    };
  }

  return {
    ...base,
    id: 'request-goto',
    title: 'Last step: ask who’s free',
    body: `Send your comedians the ${month} availability request from the dashboard.`,
    targets: ['nav-dashboard'],
    placement: ['right'],
    primary: { label: 'Go to dashboard', command: { type: 'navigate', to: DASHBOARD_PATH } },
  };
}

/** The coach mark to show, or null when there's nothing to guide. */
export function computeMark(input: GuideInput): GuideMark | null {
  const { data, pathname } = input;
  if (input.finishing) return finishMark(data);
  if (data.mode === 'tour') return tourMark(input.local.tourIndex);

  const done = (key: OnboardingStepKey) => data.steps.find((s) => s.key === key)?.status === 'done';
  if (data.currentStep === null) return finishMark(data);
  if (!done('club')) return clubMark(pathname);
  if (!done('shows')) return showsMark(input);

  // Celebrate the shows step on its own screen before moving on (Next → comedians).
  if (samePath(pathname, CREATE_SHOWS_PATH) && !input.local.ackShows) {
    return {
      id: 'shows-done',
      kicker: stepKicker('shows'),
      title: `${plural(data.counts.scheduledShows, 'show')} on the calendar`,
      body: 'That’s a month taking shape. Next: the comedians you book.',
      targets: ['shows-calendar'],
      placement: ['left', 'top', 'bottom'],
      primary: { label: 'Next', command: { type: 'navigate', to: COMEDIANS_PATH, patch: { ackShows: true } } },
      skipLabel: SKIP_GUIDE,
      progressLabel: stepProgress('shows'),
    };
  }
  return comediansMark(input);
}

/** The rail's steps: `Club ✓ — Shows · 2 of 3 — Comedians`. */
export interface RailStep {
  key: OnboardingStepKey;
  label: string;
  status: 'done' | 'current' | 'todo';
  /** "2 of 3" while the shows step isn't done. */
  detail?: string;
}

export function railSteps(data: OnboardingResponse): RailStep[] {
  return data.steps.map((step) => ({
    key: step.key,
    label: STEP_LABELS[step.key],
    status: step.status,
    detail:
      step.progress && step.status !== 'done'
        ? `${Math.min(step.progress.count, step.progress.target)} of ${step.progress.target}`
        : undefined,
  }));
}
