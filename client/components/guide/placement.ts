/**
 * Where the coach card goes (pure; unit-tested in placement.test.ts): next to its target on the
 * first side where it fits whole, flipping to the other sides when it doesn't, aligned with the
 * target and clamped onto the screen. A target too big to sit beside (a whole calendar on a
 * small screen) gets the screen corner that covers it least. No target → centered.
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

export function placeCard(
  target: Box | null,
  card: Size,
  viewport: Viewport,
  prefer: readonly Side[] = ALL_SIDES,
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

  const candidates = [...prefer, ...ALL_SIDES.filter((s) => !prefer.includes(s))].map((side) => {
    switch (side) {
      case 'right': {
        const left = right + CARD_GAP;
        return { side, left, top: besideTop(), fits: left + card.width <= viewport.width - SCREEN_MARGIN, room: viewport.width - right };
      }
      case 'left': {
        const left = target.left - CARD_GAP - card.width;
        return { side, left, top: besideTop(), fits: left >= SCREEN_MARGIN, room: target.left };
      }
      case 'bottom': {
        const top = bottom + CARD_GAP;
        return {
          side,
          left: aboveBelowLeft(),
          top,
          fits: top + card.height <= viewport.height - SCREEN_MARGIN,
          room: viewport.height - bottom,
        };
      }
      case 'top': {
        const top = target.top - CARD_GAP - card.height;
        return { side, left: aboveBelowLeft(), top, fits: top >= minTop, room: target.top - minTop };
      }
    }
  });

  const fit = candidates.find((c) => c.fits);
  if (fit) return { side: fit.side, left: clampLeft(fit.left), top: clampTop(fit.top) };

  // Nowhere beside it: the screen corner that hides the least of the target.
  const corners = [
    { left: SCREEN_MARGIN, top: minTop },
    { left: maxLeft, top: minTop },
    { left: SCREEN_MARGIN, top: maxTop },
    { left: maxLeft, top: maxTop },
  ];
  const covered = (c: { left: number; top: number }) => {
    const w = Math.min(c.left + card.width, right) - Math.max(c.left, target.left);
    const h = Math.min(c.top + card.height, bottom) - Math.max(c.top, target.top);
    return Math.max(0, w) * Math.max(0, h);
  };
  const best = corners.reduce((a, c) => (covered(c) < covered(a) ? c : a));
  return { side: 'corner', left: Math.round(best.left), top: Math.round(best.top) };
}
