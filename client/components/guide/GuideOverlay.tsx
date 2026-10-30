/**
 * What the guide draws over the booker app (rendered once, by BookerLayout):
 *
 * - md+ : a dimming layer with a cut-out and a spotlight ring around the lit target(s), and the
 *   coach card next to the target (flipping sides to stay on screen, following scroll, resize
 *   and DOM changes; centered when the target isn't on the page). The dim is visual only
 *   (`pointer-events: none`): the whole page stays usable. The lit element is also raised above
 *   the dim.
 * - < 768px: no spotlight; the coach card docks as a bottom sheet.
 * - Docked marks (a form to fill in underneath, e.g. Connect your email): no dim, and the card
 *   sits in the page flow where the page renders a `GuideDockSlot` (Settings), so it never covers
 *   the form; on a page without a slot it floats top-right.
 * - Minimized (Esc): a "Setup guide · Step 2 of 3 — Resume" pill.
 * - While a dialog is open (Radix, z-50, above all of this) the card steps aside and a small
 *   hint above the dialog's overlay says what to do (below the dialog on wider screens, where
 *   toasts take the top; at the top on phones, where dialogs are bottom sheets); the guide
 *   keeps tracking data underneath.
 *
 * The coach card is a labelled, non-modal dialog: no focus trap, reachable by keyboard, Esc
 * minimizes it. Stacking: dim z-25 · lit target z-26 · rings z-27 · rail z-30 · card z-45 ·
 * dialogs z-50 · dialog hint z-60.
 */
import { ChevronLeft, Compass, Minus } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import { useGuide, type GuideContextValue } from './GuideProvider';
import { intersects, mergeNearby, placeCard, unionBox, type Box, type Placement, type Size } from './placement';
import type { GuideMark } from './script';
import { useTargetLayout, type TargetLayout } from './useTargetLayout';

/** Below this width there is no spotlight: the card is a bottom sheet. */
export const GUIDE_SHEET_QUERY = '(max-width: 767px)';

/** Padding between a lit element and its ring. */
const RING_PAD = 6;

function ringBox(b: Box): Box {
  return { top: b.top - RING_PAD, left: b.left - RING_PAD, width: b.width + RING_PAD * 2, height: b.height + RING_PAD * 2 };
}

const FOREIGN_DIALOG = '[role="dialog"][data-state="open"]:not([data-guide-card]), [role="alertdialog"][data-state="open"]';
/** Layers that own Esc themselves (dialogs, menus, popovers). */
const FOREIGN_LAYER = `${FOREIGN_DIALOG}, [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]`;

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** Whether some other dialog (Radix) is open right now. */
function useForeignDialogOpen(enabled: boolean): boolean {
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setIsOpen(false);
      return;
    }
    const check = () => setIsOpen(document.querySelector(FOREIGN_DIALOG) != null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    return () => observer.disconnect();
  }, [enabled]);
  return isOpen;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Scroll the window so `el` sits in the visible band between the top chrome and `insetBottom`. */
function reveal(el: HTMLElement, insetTop: number, insetBottom: number): void {
  const r = el.getBoundingClientRect();
  const top = insetTop + 8;
  const bottom = window.innerHeight - insetBottom - 8;
  if (r.top >= top && r.bottom <= bottom) return;
  const band = bottom - top;
  const offset = r.height < band ? (band - r.height) / 2 : 0;
  window.scrollTo({ top: window.scrollY + r.top - top - offset, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/**
 * Bring the mark's first target into view when it shows up, and again if the page shifts it
 * off screen while loading (e.g. a card above it renders late) — until the booker scrolls on
 * their own.
 */
function useRevealTarget(mark: GuideMark, layout: TargetLayout, insetBottom: number): void {
  const state = useRef<{ mark: string; docTop: number | null; userScrolled: boolean }>({
    mark: '',
    docTop: null,
    userScrolled: false,
  });
  const first = layout.elements[0];
  const rect = layout.rects[0];

  useEffect(() => {
    state.current = { mark: mark.id, docTop: null, userScrolled: false };
    const userScroll = () => {
      state.current.userScrolled = true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' '].includes(e.key)) userScroll();
    };
    window.addEventListener('wheel', userScroll, { passive: true });
    window.addEventListener('touchmove', userScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', userScroll);
      window.removeEventListener('touchmove', userScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, [mark.id]);

  useEffect(() => {
    const current = state.current;
    if (!first || !rect || current.mark !== mark.id || current.userScrolled) return;
    const docTop = Math.round(rect.top + window.scrollY);
    // Only when it first appears or the layout moved it (not while our own scroll runs).
    if (current.docTop !== null && Math.abs(current.docTop - docTop) < 4) return;
    current.docTop = docTop;
    reveal(first, layout.viewport.insetTop ?? 0, insetBottom);
  }, [mark.id, first, rect, layout.viewport.insetTop, insetBottom]);
}

/** Raise the lit elements above the dim (restored when the mark moves on). */
function useRaised(elements: HTMLElement[]): void {
  useEffect(() => {
    const restore = elements.map((el) => {
      const { position, zIndex } = el.style;
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.style.zIndex = '26';
      el.setAttribute('data-guide-lit', '');
      return () => {
        el.style.position = position;
        el.style.zIndex = zIndex;
        el.removeAttribute('data-guide-lit');
      };
    });
    return () => restore.forEach((fn) => fn());
  }, [elements]);
}

/** Esc minimizes the card (unless a dialog, menu or popover is handling it). */
function useEscapeToMinimize(minimize: (() => void) | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !minimize) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector(FOREIGN_LAYER)) return;
      minimize();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, minimize]);
}

const DOCK_SLOT = '[data-guide-dock]';

/**
 * Where a docked mark's card goes on wider screens: in the page flow, above the page's content,
 * so it never covers the form it's about. Pages with docked marks (Settings → Locations, Email)
 * render one; without it the card floats top-right.
 */
export function GuideDockSlot({ className }: { className?: string }) {
  return <div data-guide-dock="" className={cn('empty:hidden', className)} />;
}

/** The page's `GuideDockSlot`, tracked as pages mount and unmount. */
function useDockSlot(enabled: boolean): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      setSlot(null);
      return;
    }
    const find = () => setSlot(document.querySelector<HTMLElement>(DOCK_SLOT));
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [enabled]);
  return slot;
}

/** Card size, measured before paint and whenever its content reflows. */
function useElementSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function GuideOverlay() {
  const guide = useGuide();
  const rootRef = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery(GUIDE_SHEET_QUERY);
  const active = Boolean(guide?.open && guide.mark);
  const dialogOpen = useForeignDialogOpen(active);
  useEscapeToMinimize(guide?.minimize, active && !guide?.minimized);

  if (!guide || !guide.open || !guide.mark) return null;
  const { mark } = guide;
  const label = guide.mode === 'tour' && mark.id !== 'finish' ? 'Welcome tour' : 'Setup guide';

  let content;
  if (guide.minimized) content = <ResumePill label={label} progress={mark.progressLabel} onResume={guide.restore} />;
  else if (dialogOpen) content = mark.dialogHint ? <DialogHint text={mark.dialogHint} /> : null;
  else if (sheet) content = <BottomSheet guide={guide} mark={mark} rootRef={rootRef} />;
  else content = <Spotlight guide={guide} mark={mark} rootRef={rootRef} />;

  return createPortal(
    <div ref={rootRef} data-guide-root="">
      {content}
      <p aria-live="polite" className="sr-only">
        {guide.minimized ? `${label} minimized` : `${label}. ${mark.kicker}. ${mark.title}`}
      </p>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Desktop: dim + spotlight + floating card
// ---------------------------------------------------------------------------

function Spotlight({ guide, mark, rootRef }: { guide: GuideContextValue; mark: GuideMark; rootRef: RefObject<HTMLDivElement | null> }) {
  const layout = useTargetLayout(mark.targets, true, rootRef);
  const cardRef = useRef<HTMLElement>(null);
  const size = useElementSize(cardRef);
  useRevealTarget(mark, layout, 0);
  useRaised(layout.elements);

  const holes = layout.rects;
  const anchor: Box | null = mark.anchor === 'union' ? unionBox(holes) : (holes[0] ?? null);
  const anchorRing = anchor && ringBox(anchor);
  // Targets side by side (Import CSV + Add comedian) share one spotlight.
  const lit = mergeNearby(holes.map(ringBox), 12);
  // The card sits by its anchor and never covers the other lit element (chips + calendar).
  const avoid = anchorRing ? lit.filter((b) => !intersects(b, anchorRing)) : [];
  const viewport = layout.viewport.width ? layout.viewport : { width: window.innerWidth, height: window.innerHeight, insetTop: 0 };
  const corner = mark.targets.length === 0 && mark.dock === 'corner';
  const dockSlot = useDockSlot(corner);

  let placement: Placement | null = null;
  if (size) {
    // Docked without a slot on the page: top-right, undimmed.
    placement = corner
      ? { side: 'corner', left: viewport.width - size.width - 24, top: (viewport.insetTop ?? 0) + 12 }
      : placeCard(anchorRing, size, viewport, mark.placement, avoid);
  }

  // Glide between positions, but appear in place the first time.
  const placed = useRef(false);
  useEffect(() => {
    if (placement) placed.current = true;
  });

  if (corner && dockSlot) {
    return createPortal(
      <CoachCard
        guide={guide}
        mark={mark}
        cardRef={cardRef}
        className="animate-fade-in rounded-xl border border-accent/40 bg-surface p-4 shadow-sm ring-4 ring-accent-soft"
      />,
      dockSlot,
    );
  }

  return (
    <>
      {!corner && <Dim holes={lit} />}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[27]">
        {lit.map((r, i) => (
          <div
            key={i}
            className="absolute animate-fade-in rounded-[10px] outline-2 outline-accent shadow-[0_0_0_6px_var(--accent-soft)]"
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
          />
        ))}
      </div>
      <CoachCard
        guide={guide}
        mark={mark}
        cardRef={cardRef}
        className={cn(
          'fixed z-[45] w-80 rounded-xl border border-border bg-surface p-4 shadow-2xl ring-1 ring-black/5 dark:ring-white/5',
          placed.current && 'transition-[top,left] duration-200 ease-out',
        )}
        style={
          placement
            ? { top: placement.top, left: placement.left }
            : { top: 0, left: 0, visibility: 'hidden' }
        }
      />
    </>
  );
}

/** The dim, with a rounded cut-out per lit element. */
function Dim({ holes }: { holes: Box[] }) {
  const maskId = useId();
  return (
    <svg aria-hidden className="pointer-events-none fixed inset-0 z-[25] size-full animate-fade-in">
      <defs>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          {holes.map((b, i) => (
            <rect key={i} x={b.left} y={b.top} width={b.width} height={b.height} rx={10} fill="black" />
          ))}
        </mask>
      </defs>
      <rect width="100%" height="100%" mask={`url(#${maskId})`} className="fill-zinc-950/45 dark:fill-black/55" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Phone: bottom sheet (no spotlight)
// ---------------------------------------------------------------------------

function BottomSheet({ guide, mark, rootRef }: { guide: GuideContextValue; mark: GuideMark; rootRef: RefObject<HTMLDivElement | null> }) {
  const layout = useTargetLayout(mark.targets, true, rootRef);
  const cardRef = useRef<HTMLElement>(null);
  const size = useElementSize(cardRef);
  const height = size?.height ?? 0;
  useRevealTarget(mark, layout, height);

  // Keep the page's end (and phone toasts) clear of the sheet.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--guide-sheet-h', `${height}px`);
    root.setProperty('--toast-bottom-offset', `${height + 12}px`);
    return () => {
      root.removeProperty('--guide-sheet-h');
      root.removeProperty('--toast-bottom-offset');
    };
  }, [height]);

  return (
    <CoachCard
      guide={guide}
      mark={mark}
      cardRef={cardRef}
      sheet
      className="fixed inset-x-0 bottom-0 z-[45] max-h-[60dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface px-4 pt-2.5 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-10px_30px_-12px_rgb(0_0_0/0.3)] animate-pop-in"
    />
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function CoachCard({
  guide,
  mark,
  cardRef,
  className,
  style,
  sheet = false,
}: {
  guide: GuideContextValue;
  mark: GuideMark;
  cardRef: RefObject<HTMLElement | null>;
  className: string;
  style?: CSSProperties;
  sheet?: boolean;
}) {
  const titleId = useId();
  const bodyId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const { takeFocusRequest } = guide;

  // Keyboard users who pressed a card button (or Resume) stay in the card as it changes.
  useEffect(() => {
    if (takeFocusRequest()) (primaryRef.current ?? cardRef.current)?.focus({ preventScroll: true });
  }, [mark.id, takeFocusRequest, cardRef]);

  return (
    <section
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-guide-card=""
      data-guide-mark={mark.id}
      tabIndex={-1}
      className={cn('text-left outline-none', className)}
      style={style}
    >
      {sheet && <div aria-hidden className="mx-auto mb-2 h-1 w-9 rounded-full bg-surface-3" />}
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 pt-0.5 text-[11px] font-semibold tracking-wide text-accent uppercase">{mark.kicker}</p>
        <button
          type="button"
          onClick={guide.minimize}
          className="-mt-1 -mr-1.5 rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          aria-label="Minimize the guide (Esc)"
          title="Minimize (Esc)"
        >
          <Minus className="size-4" aria-hidden />
        </button>
      </div>
      <h2 id={titleId} className="mt-0.5 text-[15px] leading-snug font-semibold text-fg">
        {mark.title}
      </h2>
      <div id={bodyId} className="mt-1 space-y-2 text-[13px] leading-relaxed text-fg-muted">
        <p>{mark.body}</p>
        {mark.list && (
          <ol className="space-y-1.5">
            {mark.list.map((item, i) => (
              <li key={item} className="flex gap-2.5">
                <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                  {i + 1}
                </span>
                <span className="text-fg">{item}</span>
              </li>
            ))}
          </ol>
        )}
        {mark.note && (
          <p className="rounded-md border border-awaiting/35 bg-awaiting-soft px-2.5 py-1.5 text-xs text-awaiting-fg">{mark.note}</p>
        )}
        {!mark.primary && mark.waiting && (
          <p className="flex items-center gap-2 text-xs font-medium text-accent">
            <span aria-hidden className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex size-2 rounded-full bg-accent-solid" />
            </span>
            {mark.waiting}
          </p>
        )}
      </div>
      {mark.id.startsWith('tour-') && <TourDots current={mark.progressLabel} />}
      <div className="mt-3.5 flex flex-wrap items-center gap-x-2 gap-y-2">
        {mark.skipLabel && (
          <button
            type="button"
            onClick={guide.skip}
            className="-ml-1 rounded px-1 py-1 text-xs text-fg-muted hover:text-fg hover:underline"
          >
            {mark.skipLabel}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {mark.back && (
            <Button size="sm" variant="ghost" onClick={() => guide.run(mark.back!)} className="text-fg-muted">
              <ChevronLeft aria-hidden /> Back
            </Button>
          )}
          {mark.secondary && (
            <Button size="sm" variant="secondary" onClick={() => guide.run(mark.secondary!.command)}>
              {mark.secondary.label}
            </Button>
          )}
          {mark.primary && (
            <Button ref={primaryRef} size="sm" onClick={() => guide.run(mark.primary!.command)}>
              {mark.primary.label}
            </Button>
          )}

        </div>
      </div>
    </section>
  );
}

function TourDots({ current }: { current: string }) {
  const [index, total] = current.split(' of ').map(Number) as [number, number];
  return (
    <div aria-hidden className="mt-3 flex gap-1">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn('h-1 rounded-full transition-all', i + 1 === index ? 'w-4 bg-accent-solid' : 'w-1.5 bg-surface-3')} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimized pill, dialog hint
// ---------------------------------------------------------------------------

function ResumePill({ label, progress, onResume }: { label: string; progress: string; onResume: () => void }) {
  return (
    <button
      type="button"
      onClick={onResume}
      data-guide-pill=""
      className="fixed right-4 bottom-4 z-[45] flex animate-pop-in items-center gap-2 rounded-full border border-border bg-surface py-2 pr-4 pl-3 text-[13px] shadow-lg hover:border-accent md:right-6 md:bottom-6"
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Compass className="size-3.5" aria-hidden />
      </span>
      <span className="font-medium text-fg">
        {label} · {progress}
      </span>
      <span aria-hidden className="text-fg-subtle">
        —
      </span>
      <span className="font-semibold text-accent">Resume</span>
    </button>
  );
}

function DialogHint({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed top-3 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full bg-accent-solid py-1.5 pr-3.5 pl-2.5 text-xs font-medium text-accent-solid-fg shadow-lg sm:top-auto sm:bottom-5"
    >
      <Compass className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </div>
  );
}
