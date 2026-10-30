/**
 * Where the coach card goes (pure; unit-tested in placement.test.ts): next to its target on the
 * first side where it fits whole, flipping to the other sides when it doesn't, aligned with the
 * target and clamped onto the screen. It never covers the other lit elements (`avoid`): above or
 * below its target it slides sideways to clear them. A target too big to sit beside (a whole
 * calendar on a small screen) gets the screen corner that covers it least, keeping clear of the
 * target's heading (its top band). No target → centered.
 */

export type Side = 'right' | 'left' | 'bottom' | 'top';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport extends Size {
  /** Space taken at the top by sticky chrome (the guide rail, the phone header). */
  insetTop?: number;
}

export interface Placement {
  top: number;
  left: number;
  side: Side | 'center' | 'corner';
}

/** Space between the target's ring and the card. */
export const CARD_GAP = 16;
/** Minimum space between the card and the screen edge. */
export const SCREEN_MARGIN = 12;
/** The top of a target that holds its heading ("November 2026"): a corner card avoids it. */
export const HEADING_BAND = 72;
/** How much worse covering the heading band is than covering the rest of the target. */
const HEADING_WEIGHT = 4;

const ALL_SIDES: Side[] = ['right', 'bottom', 'left', 'top'];

/** The smallest box around all of `boxes` (null for none). */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const top = Math.min(...boxes.map((b) => b.top));
  const left = Math.min(...boxes.map((b) => b.left));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  return { top, left, width: right - left, height: bottom - top };
}

/** Whether two boxes overlap (touching edges don't count). */
export function intersects(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return Math.max(0, w) * Math.max(0, h);
}

function nearby(a: Box, b: Box, slack: number): boolean {
  return (
    a.left - slack <= b.left + b.width &&
    b.left - slack <= a.left + a.width &&
    a.top - slack <= b.top + b.height &&
    b.top - slack <= a.top + a.height
  );
}

/**
 * Merge boxes that touch or nearly touch (within `slack` px) into one, so adjacent targets
 * (two buttons side by side) get one spotlight instead of overlapping rings.
 */
export function mergeNearby(boxes: readonly Box[], slack: number): Box[] {
  let merged = [...boxes];
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        if (nearby(merged[i]!, merged[j]!, slack)) {
          const union = unionBox([merged[i]!, merged[j]!])!;
          merged = [...merged.slice(0, i), union, ...merged.slice(i + 1, j), ...merged.slice(j + 1)];
          changed = true;
          break outer;
        }
      }
    }
  }
  return merged;
}

export function centerCard(card: Size, viewport: Viewport): Placement {
  const insetTop = viewport.insetTop ?? 0;
  return {
    left: Math.max(SCREEN_MARGIN, Math.round((viewport.width - card.width) / 2)),
    top: Math.max(insetTop + SCREEN_MARGIN, Math.round(insetTop + (viewport.height - insetTop - card.height) / 2)),
    side: 'center',
  };
}

/**
 * @param target  the lit element's ring (null → centered)
 * @param avoid   other lit elements the card must not cover (e.g. the calendar lit beside the
 *                weekday chips)
 */
export function placeCard(
  target: Box | null,
  card: Size,
  viewport: Viewport,
  prefer: readonly Side[] = ALL_SIDES,
  avoid: readonly Box[] = [],
): Placement {
  if (!target) return centerCard(card, viewport);

  const minTop = (viewport.insetTop ?? 0) + SCREEN_MARGIN;
  const maxTop = Math.max(minTop, viewport.height - card.height - SCREEN_MARGIN);
  const maxLeft = Math.max(SCREEN_MARGIN, viewport.width - card.width - SCREEN_MARGIN);
  const clampTop = (v: number) => Math.round(Math.min(Math.max(v, minTop), maxTop));
  const clampLeft = (v: number) => Math.round(Math.min(Math.max(v, SCREEN_MARGIN), maxLeft));

  const right = target.left + target.width;
  const bottom = target.top + target.height;
  // Beside a target: line the card's top up with it (or its bottom, if it would run off-screen).
  const besideTop = () =>
    clampTop(target.top + card.height <= viewport.height - SCREEN_MARGIN ? target.top : bottom - card.height);
  // Above/below: start-align, or end-align when the card would run off the right edge.
  const aboveBelowLeft = () =>
    clampLeft(target.left + card.width <= viewport.width - SCREEN_MARGIN ? target.left : right - card.width);

  const cardAt = (left: number, top: number): Box => ({ left, top, width: card.width, height: card.height });
  const clear = (left: number, top: number) => !avoid.some((a) => intersects(cardAt(left, top), a));
  // Above/below: if the card would cover another lit element, slide it sideways just clear of it
  // (still overlapping its own target, still on screen).
  const slideClear = (left: number, top: number): number | null => {
    if (clear(left, top)) return left;
    for (const a of avoid) {
      for (const next of [a.left - CARD_GAP / 2 - card.width, a.left + a.width + CARD_GAP / 2]) {
        const onScreen = next >= SCREEN_MARGIN && next + card.width <= viewport.width - SCREEN_MARGIN;
        const besideTarget = next < right && next + card.width > target.left;
        if (onScreen && besideTarget && clear(next, top)) return next;
      }
    }
    return null;
  };

  const candidates = [...prefer, ...ALL_SIDES.filter((s) => !prefer.includes(s))].map((side) => {
    switch (side) {
      case 'right': {
        const left = right + CARD_GAP;
        const top = besideTop();
        return { side, left, top, fits: left + card.width <= viewport.width - SCREEN_MARGIN && clear(left, top) };
      }
      case 'left': {
        const left = target.left - CARD_GAP - card.width;
        const top = besideTop();
        return { side, left, top, fits: left >= SCREEN_MARGIN && clear(left, top) };
      }
      case 'bottom': {
        const top = bottom + CARD_GAP;
        const left = slideClear(aboveBelowLeft(), top);
        return { side, left: left ?? 0, top, fits: left !== null && top + card.height <= viewport.height - SCREEN_MARGIN };
      }
      case 'top': {
        const top = target.top - CARD_GAP - card.height;
        const left = slideClear(aboveBelowLeft(), top);
        return { side, left: left ?? 0, top, fits: left !== null && top >= minTop };
      }
    }
  });

  const fit = candidates.find((c) => c.fits);
  if (fit) return { side: fit.side, left: clampLeft(fit.left), top: clampTop(fit.top) };

  // Nowhere beside it: the screen corner that hides the least of the target (and of the other
  // lit elements), where covering the target's heading counts several times over.
  const corners = [
    { left: SCREEN_MARGIN, top: minTop },
    { left: maxLeft, top: minTop },
    { left: SCREEN_MARGIN, top: maxTop },
    { left: maxLeft, top: maxTop },
  ];
  const heading: Box = { ...target, height: Math.min(HEADING_BAND, target.height) };
  const covered = (c: { left: number; top: number }) => {
    const box = cardAt(c.left, c.top);
    const others = avoid.reduce((sum, a) => sum + overlapArea(box, a), 0);
    return overlapArea(box, target) + HEADING_WEIGHT * overlapArea(box, heading) + others;
  };
  const best = corners.reduce((a, c) => (covered(c) < covered(a) ? c : a));
  return { side: 'corner', left: Math.round(best.left), top: Math.round(best.top) };
}
