/**
 * Shared state for the lineup board's pieces (show cards, slots, chips, pool cards), so the
 * page wires drag-and-drop and click-to-place once and the leaves just ask.
 */
import { createContext, useContext } from 'react';
import type { DayResponse } from '../../../shared/api/lineup';
import type { DayIndex, DropPlan, LineupSource, LineupTarget } from './lineupModel';

/** Click-to-place: pick a comedian or booked chip, or an empty slot first. */
export type Selection = LineupSource | { kind: 'slot'; showId: number; position: number };

export interface BoardState {
  day: DayResponse;
  index: DayIndex;
  /** What is being dragged right now. */
  dragging: LineupSource | null;
  selection: Selection | null;
  /** The comedian being dragged or selected (show cards show how they fit). */
  focusComedianId: number | null;
  /** What dropping the current drag (or selection) on `target` would do. */
  preview: (target: LineupTarget) => DropPlan;
  clickComedian: (comedianId: number) => void;
  clickBooking: (bookingId: number) => void;
  clickSlot: (showId: number, position: number) => void;
  unbook: (bookingId: number) => void;
  setSlotCount: (showId: number, slotCount: number) => void;
  copyLineup: (showId: number) => void;
}

export const BoardContext = createContext<BoardState | null>(null);

export function useBoard(): BoardState {
  const board = useContext(BoardContext);
  if (!board) throw new Error('useBoard() outside the lineup board');
  return board;
}

export function isSelected(selection: Selection | null, source: Selection): boolean {
  if (!selection || selection.kind !== source.kind) return false;
  switch (source.kind) {
    case 'comedian':
      return selection.kind === 'comedian' && selection.comedianId === source.comedianId;
    case 'booking':
      return selection.kind === 'booking' && selection.bookingId === source.bookingId;
    case 'slot':
      return selection.kind === 'slot' && selection.showId === source.showId && selection.position === source.position;
  }
}
