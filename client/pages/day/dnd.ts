/**
 * dnd-kit wiring for the lineup board: draggable/droppable ids and data, sensors, collision
 * detection and a keyboard coordinate getter that jumps slot to slot.
 */
import {
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import type { LineupSource, LineupTarget } from './lineupModel';

/** Data on a draggable: the source plus a label for screen-reader announcements. */
export type DragData = LineupSource & { label: string };
/** Data on a droppable. */
export type DropData = LineupTarget & { label: string };

export const comedianDragId = (comedianId: number) => `comedian:${comedianId}`;
export const bookingDragId = (bookingId: number) => `booking:${bookingId}`;
export const slotDropId = (showId: number, position: number) => `slot:${showId}:${position}`;
export const POOL_DROP_ID = 'pool';

/**
 * Pointer drags: whatever is under the pointer (no surprise drops from the overlay grazing a
 * slot). Keyboard drags have no pointer, so fall back to rectangle overlap.
 */
export const lineupCollision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** Arrow keys move the dragged item to the nearest drop target in that direction. */
export const slotKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (!ARROWS.includes(event.code)) return undefined;
  event.preventDefault();
  const { collisionRect, droppableRects, droppableContainers, active } = context;
  if (!active || !collisionRect) return undefined;

  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  const vertical = event.code === 'ArrowUp' || event.code === 'ArrowDown';
  const sign = event.code === 'ArrowDown' || event.code === 'ArrowRight' ? 1 : -1;

  let best: { x: number; y: number; score: number } | null = null;
  for (const container of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(container.id);
    if (!rect || container.disabled) continue;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const along = (vertical ? y - cy : x - cx) * sign;
    if (along <= 4) continue;
    const across = Math.abs(vertical ? x - cx : y - cy);
    const score = along + across * 2;
    if (!best || score < best.score) best = { x, y, score };
  }
  if (!best) return undefined;
  return { x: best.x - collisionRect.width / 2, y: best.y - collisionRect.height / 2 };
};

export function useLineupSensors() {
  return useSensors(
    // A few px of movement before a drag starts, so clicks (select / hover card) still work.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // Touch: press and hold, so the pool still scrolls with a swipe.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    // Space picks up and drops; Enter is left for click-to-select.
    useSensor(KeyboardSensor, {
      coordinateGetter: slotKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] },
    }),
  );
}

export const SCREEN_READER_INSTRUCTIONS =
  'To pick up a comedian, press Space. Use the arrow keys to move between slots, Space to drop, ' +
  'Escape to cancel. Or press Enter to select, then Enter on a slot. In a lineup, Delete removes them.';
