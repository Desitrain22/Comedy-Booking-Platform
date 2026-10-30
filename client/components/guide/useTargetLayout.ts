/**
 * Where the guide's targets (`[data-guide="<id>"]`) are on screen, kept current as the page
 * scrolls, resizes, re-renders or loads: scroll (any scroller) and resize listeners, a
 * MutationObserver on the document (targets appearing / moving) and a ResizeObserver on the
 * targets. Updates are batched to one measurement per animation frame and only re-render when
 * something actually moved.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';
import type { Box, Viewport } from './placement';

export interface TargetLayout {
  /** One entry per `data-guide` id that is on the page and visible, in the given order. */
  elements: HTMLElement[];
  rects: Box[];
  viewport: Viewport;
}

/** The first visible element for a `data-guide` id (the nav renders once per breakpoint). */
export function findGuideTarget(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide="${CSS.escape(id)}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** Height of the sticky chrome at the top of the screen (guide rail, phone header). */
export function chromeInsetTop(): number {
  let inset = 0;
  for (const el of document.querySelectorAll<HTMLElement>('[data-guide-chrome]')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top <= 1) inset = Math.max(inset, r.bottom);
  }
  return Math.round(inset);
}

function toBox(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function readViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight, insetTop: chromeInsetTop() };
}

const sameBox = (a: Box, b: Box) =>
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

function sameLayout(a: TargetLayout, b: TargetLayout): boolean {
  return (
    a.elements.length === b.elements.length &&
    a.elements.every((el, i) => el === b.elements[i]) &&
    a.rects.every((r, i) => sameBox(r, b.rects[i]!)) &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height &&
    a.viewport.insetTop === b.viewport.insetTop
  );
}

function measure(ids: readonly string[]): TargetLayout {
  const elements = ids.map(findGuideTarget).filter((el): el is HTMLElement => el != null);
  return { elements, rects: elements.map(toBox), viewport: readViewport() };
}

const EMPTY: TargetLayout = { elements: [], rects: [], viewport: { width: 0, height: 0, insetTop: 0 } };

/**
 * Track the guide targets for `ids`. `ignoreRoot` is the guide's own overlay: its DOM changes
 * (the card gliding) never trigger a re-measure.
 */
export function useTargetLayout(
  ids: readonly string[],
  enabled: boolean,
  ignoreRoot: RefObject<HTMLElement | null>,
): TargetLayout {
  const [layout, setLayout] = useState<TargetLayout>(EMPTY);
  const key = ids.join(' ');

  useLayoutEffect(() => {
    if (!enabled) {
      setLayout(EMPTY);
      return;
    }
    const targetIds = key ? key.split(' ') : [];
    let frame = 0;
    let observed: HTMLElement[] = [];
    const resizeObserver = new ResizeObserver(() => schedule());

    function update() {
      frame = 0;
      const next = measure(targetIds);
      if (next.elements.length !== observed.length || next.elements.some((el, i) => el !== observed[i])) {
        resizeObserver.disconnect();
        for (const el of next.elements) resizeObserver.observe(el);
        observed = next.elements;
      }
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const mutationObserver = new MutationObserver((records) => {
      const root = ignoreRoot.current;
      if (records.some((r) => !root || !root.contains(r.target))) schedule();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-guide', 'hidden', 'open', 'data-state'],
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [key, enabled, ignoreRoot]);

  return layout;
}
