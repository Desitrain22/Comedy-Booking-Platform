import { describe, expect, it } from 'vitest';
import type { OnboardingResponse, OnboardingStepKey } from '../../../shared/api/onboarding';
import { computeMark, createShowsPath, INITIAL_LOCAL_STATE, railSteps, type GuideInput } from './script';

function onboarding(overrides: Partial<OnboardingResponse> & { shows?: number; comedians?: number; requested?: boolean } = {}): OnboardingResponse {
  const { shows = 0, comedians = 0, requested = false, ...rest } = overrides;
  const done: Record<OnboardingStepKey, boolean> = {
    club: true,
    shows: shows >= 3,
    comedians: comedians > 0 && requested,
  };
  const order: OnboardingStepKey[] = ['club', 'shows', 'comedians'];
  const currentStep = order.find((k) => !done[k]) ?? null;
  return {
    steps: order.map((key) => ({
      key,
      status: done[key] ? 'done' : key === currentStep ? 'current' : 'todo',
      ...(key === 'shows' ? { progress: { count: shows, target: 3 } } : {}),
    })),
    currentStep,
    completedAt: null,
    dismissedAt: null,
    emailConfigured: false,
    suggestedMonth: '2026-11',
    mode: 'setup',
    counts: { locations: 1, scheduledShows: shows, comedians, bookers: 1 },
    availabilityRequested: requested,
    ...rest,
  };
}

function input(overrides: Partial<GuideInput> = {}): GuideInput {
  return {
    data: onboarding(),
    pathname: '/app/shows/new',
    isAdmin: true,
    local: INITIAL_LOCAL_STATE,
    showsSelected: 0,
    finishing: false,
    ...overrides,
  };
}

const markId = (i: Partial<GuideInput>) => computeMark(input(i))?.id;

describe('setup guide: shows step', () => {
  it('walks the create-shows form: form → days → create', () => {
    const form = computeMark(input())!;
    expect(form.id).toBe('shows-form');
    expect(form.kicker).toBe('Step 2 of 3 · Shows');
    expect(form.targets).toEqual(['shows-form']);
    expect(form.primary).toEqual({ label: 'Next', command: { type: 'local', patch: { showsCursor: 1 } } });
    expect(form.back).toBeUndefined();

    const days = computeMark(input({ local: { ...INITIAL_LOCAL_STATE, showsCursor: 1 } }))!;
    expect(days.id).toBe('shows-days');
    expect(days.targets).toEqual(['shows-weekdays', 'shows-calendar']);
    expect(days.primary).toBeUndefined(); // waits for dates to be picked
    expect(days.waiting).toBe('Waiting for dates');
    expect(days.back).toEqual({ type: 'local', patch: { showsCursor: 0 } });

    const create = computeMark(input({ local: { ...INITIAL_LOCAL_STATE, showsCursor: 2 }, showsSelected: 4 }))!;
    expect(create.id).toBe('shows-create');
    expect(create.title).toBe('4 shows ready');
    expect(create.targets).toEqual(['shows-create']);
    expect(create.primary).toBeUndefined(); // waits for the real Create
  });

  it('goes back to days (with Next) if the dates are cleared, or after Back from create', () => {
    expect(markId({ local: { ...INITIAL_LOCAL_STATE, showsCursor: 2 }, showsSelected: 0 })).toBe('shows-days');
    const back = computeMark(input({ local: { ...INITIAL_LOCAL_STATE, showsCursor: 1 }, showsSelected: 4 }))!;
    expect(back.id).toBe('shows-days');
    expect(back.primary?.command).toEqual({ type: 'local', patch: { showsCursor: 2 } });
  });

  it('asks for a couple more until there are 3, then celebrates with Next', () => {
    const more = computeMark(input({ data: onboarding({ shows: 2 }) }))!;
    expect(more.id).toBe('shows-more');
    expect(more.title).toBe('2 shows on the calendar');
    expect(more.body).toMatch(/Add a couple more/);
    expect(markId({ data: onboarding({ shows: 1 }), showsSelected: 2 })).toBe('shows-create');

    const done = computeMark(input({ data: onboarding({ shows: 4 }) }))!;
    expect(done.id).toBe('shows-done');
    expect(done.title).toBe('4 shows on the calendar');
    expect(done.primary).toEqual({
      label: 'Next',
      command: { type: 'navigate', to: '/app/comedians', patch: { ackShows: true } },
    });
  });

  it('points to Create shows from anywhere else', () => {
    const away = computeMark(input({ pathname: '/app' }))!;
    expect(away.id).toBe('shows-goto');
    expect(away.targets).toEqual(['nav-calendar']);
    expect(away.primary?.command).toEqual({ type: 'navigate', to: createShowsPath('2026-11') });
  });
});

describe('setup guide: comedians step', () => {
  const showsDone = { shows: 3 };

  it('lights Import CSV + Add comedian on the roster, and waits for a comedian', () => {
    const add = computeMark(input({ data: onboarding(showsDone), pathname: '/app/comedians', local: { ...INITIAL_LOCAL_STATE, ackShows: true } }))!;
    expect(add.id).toBe('comedians-add');
    expect(add.kicker).toBe('Step 3 of 3 · Comedians');
    expect(add.targets).toEqual(['comedians-import', 'comedians-add']);
    expect(add.anchor).toBe('union');
    expect(add.primary).toBeUndefined();
    expect(add.waiting).toBe('Waiting for your first comedian');
    expect(add.dialogHint).toBeTruthy();
    // Back returns to the shows celebration.
    expect(add.back).toEqual({ type: 'navigate', to: createShowsPath('2026-11'), patch: { ackShows: false } });
    expect(markId({ data: onboarding(showsDone), pathname: '/app' })).toBe('comedians-goto');
  });

  it('skips the shows celebration once acknowledged (or anywhere but Create shows)', () => {
    expect(markId({ data: onboarding(showsDone), local: { ...INITIAL_LOCAL_STATE, ackShows: true } })).toBe('comedians-goto');
    expect(markId({ data: onboarding(showsDone), pathname: '/app/calendar' })).toBe('comedians-goto');
  });

  it('celebrates the roster, then sends the booker to the dashboard', () => {
    const roster = computeMark(input({ data: onboarding({ ...showsDone, comedians: 5 }), pathname: '/app/comedians' }))!;
    expect(roster.id).toBe('comedians-done');
    expect(roster.title).toBe('5 comedians on the roster');
    expect(roster.primary?.command).toEqual({ type: 'navigate', to: '/app', patch: { ackComedians: true } });
    expect(
      markId({ data: onboarding({ ...showsDone, comedians: 5 }), pathname: '/app/comedians', local: { ...INITIAL_LOCAL_STATE, ackComedians: true } }),
    ).toBe('request-goto');
  });

  it('lights Request availability; without email: Send anyway or (admins) Connect email', () => {
    const data = onboarding({ ...showsDone, comedians: 1 });
    const request = computeMark(input({ data, pathname: '/app' }))!;
    expect(request.id).toBe('request');
    expect(request.targets).toEqual(['dashboard-request-availability']);
    expect(request.body).toMatch(/November availability request/);
    expect(request.note).toMatch(/outbox/);
    expect(request.primary).toEqual({ label: 'Send anyway', command: { type: 'page-action', name: 'request-availability' } });
    expect(request.secondary).toEqual({ label: 'Connect email', command: { type: 'navigate', to: '/app/settings/email' } });
    expect(request.dialogHint).toMatch(/November and Everyone/);

    const booker = computeMark(input({ data, pathname: '/app', isAdmin: false }))!;
    expect(booker.secondary).toBeUndefined();

    const connected = computeMark(input({ data: { ...data, emailConfigured: true }, pathname: '/app' }))!;
    expect(connected.primary?.label).toBe('Request availability');
    expect(connected.note).toBeUndefined();
    expect(connected.secondary).toBeUndefined();
  });

  it('waits on the email settings, then leads back to the guide', () => {
    const data = onboarding({ ...showsDone, comedians: 1 });
    const email = computeMark(input({ data, pathname: '/app/settings/email' }))!;
    expect(email.id).toBe('request-email');
    expect(email.title).toBe('Connect your email');
    expect(email.dock).toBe('corner');
    expect(email.primary?.command).toEqual({ type: 'navigate', to: '/app' });
    expect(computeMark(input({ data: { ...data, emailConfigured: true }, pathname: '/app/settings/email' }))!.title).toBe(
      'Email is connected',
    );
  });
});

describe('setup guide: finish and club', () => {
  it('shows "You’re set up" when finishing or once every step is done', () => {
    const all = onboarding({ shows: 3, comedians: 2, requested: true });
    const finish = computeMark(input({ data: all, pathname: '/app' }))!;
    expect(finish.id).toBe('finish');
    expect(finish.title).toBe('You’re set up');
    expect(finish.list).toHaveLength(3);
    expect(finish.primary).toEqual({ label: 'Done', command: { type: 'complete' } });
    expect(finish.skipLabel).toBeUndefined();
    expect(finish.note).toMatch(/outbox/);
    expect(computeMark(input({ data: { ...all, emailConfigured: true } }))!.note).toBeUndefined();
    // Finishing wins even when the booker's mode has just turned to the tour.
    expect(markId({ data: { ...all, mode: 'tour' }, finishing: true })).toBe('finish');
  });

  it('asks for a location when the club has none', () => {
    const data = onboarding();
    data.steps[0] = { key: 'club', status: 'current' };
    data.currentStep = 'club';
    expect(markId({ data, pathname: '/app' })).toBe('club-goto');
    expect(markId({ data, pathname: '/app/settings/locations' })).toBe('club-location');
  });
});

describe('welcome tour', () => {
  const tour = onboarding({ mode: 'tour', shows: 3, comedians: 3, requested: true });

  it('walks the four nav items with Back/Next, and ends with Done', () => {
    const marks = [0, 1, 2, 3].map((tourIndex) => computeMark(input({ data: tour, pathname: '/app', local: { ...INITIAL_LOCAL_STATE, tourIndex } }))!);
    expect(marks.map((m) => m.targets[0])).toEqual(['nav-dashboard', 'nav-calendar', 'nav-comedians', 'nav-settings']);
    expect(marks.map((m) => m.kicker)).toEqual([
      'Welcome tour · 1 of 4',
      'Welcome tour · 2 of 4',
      'Welcome tour · 3 of 4',
      'Welcome tour · 4 of 4',
    ]);
    expect(marks[1]!.body).toMatch(/Click a day to build its lineups/);
    expect(marks[2]!.body).toMatch(/notes and tags/);
    expect(marks[0]!.back).toBeUndefined();
    expect(marks[0]!.primary?.command).toEqual({ type: 'local', patch: { tourIndex: 1 } });
    expect(marks[3]!.primary).toEqual({ label: 'Done', command: { type: 'complete' } });
    expect(marks[0]!.skipLabel).toBe('Skip tour');
  });
});

describe('railSteps', () => {
  it('reads "Club ✓ — Shows · 2 of 3 — Comedians"', () => {
    expect(railSteps(onboarding({ shows: 2 }))).toEqual([
      { key: 'club', label: 'Club', status: 'done', detail: undefined },
      { key: 'shows', label: 'Shows', status: 'current', detail: '2 of 3' },
      { key: 'comedians', label: 'Comedians', status: 'todo', detail: undefined },
    ]);
    expect(railSteps(onboarding({ shows: 5 }))[1]!.detail).toBeUndefined();
  });
});
