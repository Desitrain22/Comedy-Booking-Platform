/**
 * The setup guide / welcome tour engine (onboarding design §2). Wraps the booker app
 * (BookerLayout) and decides whether the guide is running, which coach mark it shows
 * (`computeMark`, script.ts) and what its buttons do. The overlay (GuideOverlay) and the
 * progress rail (GuideRail) render from this context.
 *
 * When it runs:
 * - Setup guide: on its own while it isn't finished or skipped and a step is left; it then
 *   shows "You're set up" when it sees the last step finish. "Skip guide" dismisses it for this
 *   booker; the user menu (Setup guide) and the dashboard's Getting started card reopen it.
 * - Welcome tour: on its own until finished; Skip and Done both finish it (it shows once).
 * - Once finished it never starts on its own again; reopening it is per tab.
 *
 * Its own position (and minimized / reopened state) lives in sessionStorage, so a reload
 * resumes where it was. Everything else comes from `GET /api/onboarding`, refetched after
 * mutations, related invalidations and route changes.
 *
 * Pages talk to it with two small hooks:
 *   useGuideSignal('showsSelected', count)                 what the page has picked
 *   useGuideAction('request-availability', () => open())   what the coach card can ask for
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { GuideMode, OnboardingResponse } from '../../../shared/api/onboarding';
import { useBooker } from '../../lib/useMe';
import {
  ONBOARDING_KEY,
  refreshOnboarding,
  useGuideServerAction,
  useOnboarding,
  useOnboardingAutoRefresh,
} from './onboardingQuery';
import {
  computeMark,
  INITIAL_LOCAL_STATE,
  type GuideCommand,
  type GuideMark,
  type GuidePageAction,
  type LocalGuideState,
} from './script';

export type GuideSignal = 'showsSelected';

export interface GuideContextValue {
  data: OnboardingResponse | undefined;
  mode: GuideMode | undefined;
  /** The guide is running (its card, or the minimized pill). */
  open: boolean;
  minimized: boolean;
  /** The current coach mark while open. */
  mark: GuideMark | null;
  /** Open (or reopen) the guide: user menu, Getting started. */
  start: () => void;
  /** Skip guide / Skip tour. */
  skip: () => void;
  minimize: () => void;
  restore: () => void;
  run: (command: GuideCommand) => void;
  /** True once after `restore()` or a card button: the next card should take focus. */
  takeFocusRequest: () => boolean;
  setSignal: (name: GuideSignal, value: number) => void;
  registerAction: (name: GuidePageAction, handler: () => void) => () => void;
}

const GuideContext = createContext<GuideContextValue | null>(null);

/** The guide, or null outside the booker app. */
export function useGuide(): GuideContextValue | null {
  return useContext(GuideContext);
}

/** Tell the guide what the page has picked (e.g. how many shows Create would make). */
export function useGuideSignal(name: GuideSignal, value: number): void {
  const setSignal = useGuide()?.setSignal;
  useEffect(() => {
    setSignal?.(name, value);
  }, [setSignal, name, value]);
  useEffect(() => () => setSignal?.(name, 0), [setSignal, name]);
}

/** Let the coach card trigger something on this page (e.g. open the request dialog). */
export function useGuideAction(name: GuidePageAction, handler: () => void): void {
  const registerAction = useGuide()?.registerAction;
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => registerAction?.(name, () => latest.current()), [registerAction, name]);
}

// ---------------------------------------------------------------------------
// Per-tab state (sessionStorage)
// ---------------------------------------------------------------------------

interface StoredGuide {
  /** Reopened by hand (user menu / Getting started), regardless of the server flags. */
  manualOpen: boolean;
  minimized: boolean;
  /** Showing "You're set up" (the guide saw the last step finish). */
  finishing: boolean;
  local: LocalGuideState;
}

const INITIAL_STORED: StoredGuide = { manualOpen: false, minimized: false, finishing: false, local: INITIAL_LOCAL_STATE };

/**
 * Starts on its own: not finished, not skipped, and (setup guide) a step is left. A club that
 * was already set up when this booker arrived never pops "You're set up" at them.
 */
export function autoStarts(d: OnboardingResponse): boolean {
  return d.completedAt == null && d.dismissedAt == null && (d.mode === 'tour' || d.currentStep !== null);
}

const storageKey = (userId: number) => `cbp.guide.${userId}`;

function readStored(userId: number): StoredGuide {
  try {
    const raw = sessionStorage.getItem(storageKey(userId));
    if (!raw) return INITIAL_STORED;
    const parsed = JSON.parse(raw) as Partial<StoredGuide>;
    return { ...INITIAL_STORED, ...parsed, local: { ...INITIAL_LOCAL_STATE, ...parsed.local } };
  } catch {
    return INITIAL_STORED;
  }
}

function writeStored(userId: number, value: StoredGuide): void {
  try {
    sessionStorage.setItem(storageKey(userId), JSON.stringify(value));
  } catch {
    // Private mode / storage off: the guide still works, it just won't remember its place.
  }
}

// ---------------------------------------------------------------------------

export function GuideProvider({ children }: { children: ReactNode }) {
  const booker = useBooker();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useOnboarding();
  const serverAction = useGuideServerAction();

  const [stored, setStored] = useState<StoredGuide>(() => readStored(booker.id));
  const [showsSelected, setShowsSelected] = useState(0);
  const actions = useRef(new Map<GuidePageAction, () => void>());
  const focusRequest = useRef(false);

  useEffect(() => writeStored(booker.id, stored), [booker.id, stored]);

  const isOpen = (d: OnboardingResponse | undefined) =>
    d != null && (stored.manualOpen || stored.finishing || autoStarts(d));
  const open = isOpen(data);

  // Follow the club's data while the guide runs or a step is left (and on route changes, which
  // can move the guide). A club that's set up doesn't refetch after every mutation.
  const live = open || data == null || data.currentStep !== null;
  useOnboardingAutoRefresh(live);
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    if (live) refreshOnboarding(queryClient);
    // Only on navigation (not when `live` flips).
  }, [pathname, queryClient]);

  // Transitions are handled while rendering (not in an effect) so the card never flickers.
  // Seeing the last setup step finish while the guide runs → "You're set up".
  const [previousData, setPreviousData] = useState(data);
  if (data !== previousData) {
    setPreviousData(data);
    if (
      data &&
      previousData &&
      !stored.finishing &&
      isOpen(previousData) &&
      previousData.mode === 'setup' &&
      previousData.currentStep !== null &&
      data.currentStep === null
    ) {
      setStored((s) => ({ ...s, finishing: true, minimized: false }));
    }
  }

  // Picking dates on Create shows moves "Put it on the calendar" on to "Create them".
  const [previousSelected, setPreviousSelected] = useState(showsSelected);
  if (showsSelected !== previousSelected) {
    setPreviousSelected(showsSelected);
    if (previousSelected === 0 && showsSelected > 0 && stored.local.showsCursor !== 2) {
      setStored((s) => ({ ...s, local: { ...s.local, showsCursor: 2 } }));
    }
  }

  const mark = useMemo(
    () =>
      open && data
        ? computeMark({
            data,
            pathname,
            isAdmin: booker.role === 'admin',
            local: stored.local,
            showsSelected,
            finishing: stored.finishing,
          })
        : null,
    [open, data, pathname, booker.role, stored.local, stored.finishing, showsSelected],
  );

  /** Apply a server flag locally right away, so the card doesn't linger until the response. */
  const optimistic = useCallback(
    (patch: Partial<OnboardingResponse>) => {
      void queryClient.cancelQueries({ queryKey: ONBOARDING_KEY });
      queryClient.setQueryData<OnboardingResponse>(ONBOARDING_KEY, (d) => (d ? { ...d, ...patch } : d));
    },
    [queryClient],
  );

  const sendAction = serverAction.mutate;
  const finish = useCallback(() => {
    setStored({ ...INITIAL_STORED });
    optimistic({ completedAt: data?.completedAt ?? Date.now() });
    sendAction('complete', { onError: () => refreshOnboarding(queryClient) });
  }, [data?.completedAt, optimistic, queryClient, sendAction]);

  const start = useCallback(() => {
    focusRequest.current = true;
    setStored({ ...INITIAL_STORED, manualOpen: true });
    if (data?.dismissedAt != null) {
      optimistic({ dismissedAt: null });
      sendAction('resume', { onError: () => refreshOnboarding(queryClient) });
    }
  }, [data?.dismissedAt, optimistic, queryClient, sendAction]);

  const skip = useCallback(() => {
    // The tour shows once: skipping it finishes it. The setup guide can be resumed.
    if (data?.mode === 'tour' && !stored.finishing) {
      finish();
      return;
    }
    setStored((s) => ({ ...s, manualOpen: false, finishing: false, minimized: false }));
    optimistic({ dismissedAt: Date.now() });
    sendAction('dismiss', { onError: () => refreshOnboarding(queryClient) });
  }, [data?.mode, stored.finishing, finish, optimistic, queryClient, sendAction]);

  const minimize = useCallback(() => setStored((s) => ({ ...s, minimized: true })), []);
  const restore = useCallback(() => {
    focusRequest.current = true;
    setStored((s) => ({ ...s, minimized: false }));
  }, []);

  const run = useCallback(
    (command: GuideCommand) => {
      if (document.activeElement?.closest('[data-guide-card]')) focusRequest.current = true;
      switch (command.type) {
        case 'local':
          setStored((s) => ({ ...s, local: { ...s.local, ...command.patch } }));
          break;
        case 'navigate':
          if (command.patch) setStored((s) => ({ ...s, local: { ...s.local, ...command.patch } }));
          void navigate(command.to);
          break;
        case 'page-action':
          focusRequest.current = false;
          actions.current.get(command.name)?.();
          break;
        case 'complete':
          finish();
          break;
      }
    },
    [navigate, finish],
  );

  const takeFocusRequest = useCallback(() => {
    const requested = focusRequest.current;
    focusRequest.current = false;
    return requested;
  }, []);

  const setSignal = useCallback((name: GuideSignal, value: number) => {
    if (name === 'showsSelected') setShowsSelected(value);
  }, []);

  const registerAction = useCallback((name: GuidePageAction, handler: () => void) => {
    actions.current.set(name, handler);
    return () => {
      if (actions.current.get(name) === handler) actions.current.delete(name);
    };
  }, []);

  const value = useMemo<GuideContextValue>(
    () => ({
      data,
      mode: data?.mode,
      open,
      minimized: open && stored.minimized,
      mark,
      start,
      skip,
      minimize,
      restore,
      run,
      takeFocusRequest,
      setSignal,
      registerAction,
    }),
    [data, open, stored.minimized, mark, start, skip, minimize, restore, run, takeFocusRequest, setSignal, registerAction],
  );

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}
