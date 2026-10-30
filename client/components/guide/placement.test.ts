import { describe, expect, it } from 'vitest';
import { CARD_GAP, centerCard, mergeNearby, placeCard, SCREEN_MARGIN, unionBox, type Box } from './placement';

const viewport = { width: 1440, height: 900 };
const card = { width: 320, height: 180 };

describe('placeCard', () => {
  it('centers without a target', () => {
    expect(placeCard(null, card, viewport)).toEqual({ side: 'center', left: 560, top: 360 });
    // Centered in the space under the sticky chrome.
    expect(centerCard(card, { ...viewport, insetTop: 44 })).toEqual({ side: 'center', left: 560, top: 382 });
  });

  it('sits on the first preferred side that fits, top-aligned with the target', () => {
    const navItem: Box = { top: 120, left: 8, width: 208, height: 36 };
    expect(placeCard(navItem, card, viewport, ['right'])).toEqual({ side: 'right', left: 216 + CARD_GAP, top: 120 });
  });

  it('flips when the preferred side runs off screen', () => {
    // A button at the right edge: no room on the right → left.
    const button: Box = { top: 200, left: 1300, width: 120, height: 32 };
    expect(placeCard(button, card, viewport, ['right', 'left'])).toEqual({
      side: 'left',
      left: 1300 - CARD_GAP - 320,
      top: 200,
    });
    // Near the bottom: no room below → above.
    const low: Box = { top: 820, left: 400, width: 200, height: 40 };
    expect(placeCard(low, card, viewport, ['bottom', 'top']).side).toBe('top');
  });

  it('end-aligns above/below a target at the right edge', () => {
    const headerButtons: Box = { top: 80, left: 1180, width: 220, height: 36 };
    const placed = placeCard(headerButtons, card, viewport, ['bottom']);
    expect(placed.side).toBe('bottom');
    expect(placed.top).toBe(80 + 36 + CARD_GAP);
    expect(placed.left).toBe(1180 + 220 - 320);
  });

  it('keeps the card on screen when the target is near an edge', () => {
    const low: Box = { top: 760, left: 40, width: 100, height: 30 };
    const placed = placeCard(low, card, viewport, ['right']);
    expect(placed.side).toBe('right');
    // Bottom-aligned with the target instead of running off the bottom.
    expect(placed.top).toBe(790 - 180);
    const scrolledAway: Box = { top: -400, left: 40, width: 100, height: 30 };
    expect(placeCard(scrolledAway, card, viewport, ['right']).top).toBe(SCREEN_MARGIN);
  });

  it('stays below the sticky chrome', () => {
    const nearTop: Box = { top: 30, left: 40, width: 100, height: 30 };
    expect(placeCard(nearTop, card, { ...viewport, insetTop: 44 }, ['right']).top).toBe(44 + SCREEN_MARGIN);
    // "top" doesn't fit under the chrome → next side.
    expect(placeCard({ top: 150, left: 500, width: 100, height: 30 }, card, { ...viewport, insetTop: 44 }, ['top']).side).not.toBe('top');
  });

  it('falls back to the screen corner that covers the target least when nothing fits', () => {
    // A calendar filling most of a 1024×768 screen, sidebar on the left.
    const laptop = { width: 1024, height: 768, insetTop: 44 };
    const calendar: Box = { top: 174, left: 242, width: 764, height: 576 };
    expect(placeCard(calendar, { width: 320, height: 170 }, laptop, ['left', 'top', 'bottom'])).toEqual({
      side: 'corner',
      left: SCREEN_MARGIN,
      top: 44 + SCREEN_MARGIN,
    });
    const huge: Box = { top: 20, left: 20, width: 1400, height: 860 };
    const placed = placeCard(huge, card, viewport, ['right']);
    expect(placed.side).toBe('corner');
    expect(placed.left + card.width).toBeLessThanOrEqual(viewport.width - SCREEN_MARGIN);
    expect(placed.top + card.height).toBeLessThanOrEqual(viewport.height - SCREEN_MARGIN);
  });
});

describe('mergeNearby', () => {
  it('joins boxes that touch or nearly touch, and leaves distant ones alone', () => {
    const importCsv: Box = { top: 84, left: 1126, width: 141, height: 48 };
    const addComedian: Box = { top: 84, left: 1263, width: 159, height: 48 };
    expect(mergeNearby([importCsv, addComedian], 12)).toEqual([{ top: 84, left: 1126, width: 296, height: 48 }]);
    const far: Box = { top: 600, left: 100, width: 50, height: 50 };
    expect(mergeNearby([importCsv, far], 12)).toEqual([importCsv, far]);
    // Chains merge too.
    const a: Box = { top: 0, left: 0, width: 10, height: 10 };
    const b: Box = { top: 0, left: 15, width: 10, height: 10 };
    const c: Box = { top: 0, left: 30, width: 10, height: 10 };
    expect(mergeNearby([a, c, b], 6)).toEqual([{ top: 0, left: 0, width: 40, height: 10 }]);
  });
});

describe('unionBox', () => {
  it('wraps several boxes', () => {
    expect(unionBox([])).toBeNull();
    expect(
      unionBox([
        { top: 10, left: 100, width: 50, height: 20 },
        { top: 12, left: 160, width: 80, height: 30 },
      ]),
    ).toEqual({ top: 10, left: 100, width: 140, height: 32 });
  });
});
