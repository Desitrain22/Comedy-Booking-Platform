import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  draftFromEntries,
  editorReducer,
  END_OPTIONS,
  entriesFromDraft,
  initEditor,
  paint,
  paintableWeekdayDates,
  sameDraft,
  START_OPTIONS,
  UNDO_LIMIT,
  withEnd,
  withStart,
  type EditorAction,
  type EditorState,
} from './availabilityDraft';

const ALL_NIGHT = { startMin: 1140, endMin: 1380 };
const LATE = { startMin: 1260, endMin: 1380 };

describe('availability draft', () => {
  it('paints, replaces and erases nights; no-op paints keep the same object', () => {
    const start = draftFromEntries([{ date: '2026-11-07', ...ALL_NIGHT }]);
    const painted = paint(start, ['2026-11-07', '2026-11-14'], LATE);
    expect(entriesFromDraft(painted)).toEqual([
      { date: '2026-11-07', ...LATE },
      { date: '2026-11-14', ...LATE },
    ]);
    expect(entriesFromDraft(start)).toEqual([{ date: '2026-11-07', ...ALL_NIGHT }]); // immutable

    expect(paint(painted, ['2026-11-14'], LATE)).toBe(painted);
    expect(paint(painted, ['2026-11-20'], null)).toBe(painted);

    const erased = paint(painted, ['2026-11-07', '2026-11-20'], null);
    expect(entriesFromDraft(erased)).toEqual([{ date: '2026-11-14', ...LATE }]);
  });

  it('sorts entries and can drop nights before a date', () => {
    const draft = draftFromEntries([
      { date: '2026-11-21', ...LATE },
      { date: '2026-11-03', ...LATE },
      { date: '2026-11-10', ...LATE },
    ]);
    expect(entriesFromDraft(draft).map((e) => e.date)).toEqual(['2026-11-03', '2026-11-10', '2026-11-21']);
    expect(entriesFromDraft(draft, '2026-11-10').map((e) => e.date)).toEqual(['2026-11-10', '2026-11-21']);
  });

  it('compares drafts by content, so painting back to the saved state is not dirty', () => {
    const saved = draftFromEntries([{ date: '2026-11-07', ...ALL_NIGHT }]);
    const edited = paint(saved, ['2026-11-07'], LATE);
    expect(sameDraft(saved, edited)).toBe(false);
    expect(sameDraft(saved, paint(edited, ['2026-11-07'], ALL_NIGHT))).toBe(true);
    expect(sameDraft(saved, paint(saved, ['2026-11-08'], LATE))).toBe(false);
  });

  it('weekday letters cover every such day in the month, except past ones', () => {
    expect(paintableWeekdayDates('2026-11', 6, '2026-11-01')).toEqual([
      '2026-11-07',
      '2026-11-14',
      '2026-11-21',
      '2026-11-28',
    ]);
    expect(paintableWeekdayDates('2026-11', 6, '2026-11-14')).toEqual(['2026-11-14', '2026-11-21', '2026-11-28']);
    expect(paintableWeekdayDates('2026-10', 6, '2026-11-14')).toEqual([]);
  });

  it('keeps custom ranges valid when one end moves past the other', () => {
    expect(withStart(LATE, 1200)).toEqual({ startMin: 1200, endMin: 1380 });
    expect(withStart(LATE, 1380)).toEqual({ startMin: 1380, endMin: 1500 });
    expect(withStart(LATE, 1530)).toEqual({ startMin: 1530, endMin: 1560 });
    expect(withEnd(LATE, 1440)).toEqual({ startMin: 1260, endMin: 1440 });
    expect(withEnd(LATE, 1230)).toEqual({ startMin: 1110, endMin: 1230 });
    expect(withEnd(LATE, 990)).toEqual({ startMin: 960, endMin: 990 });
  });

  it('offers half-hour times from 4 PM to 2 AM', () => {
    expect(START_OPTIONS[0]).toEqual({ value: 960, label: '4 PM' });
    expect(START_OPTIONS.at(-1)).toEqual({ value: 1530, label: '1:30 AM' });
    expect(END_OPTIONS[0]).toEqual({ value: 990, label: '4:30 PM' });
    expect(END_OPTIONS.at(-1)).toEqual({ value: 1560, label: '2 AM' });
  });

  it('labels a day with "All night" or its compact range, split at the dash', () => {
    expect(dayLabel(ALL_NIGHT, ALL_NIGHT)).toEqual({ allNight: true, parts: ['7–', '11 PM'] });
    expect(dayLabel(LATE, ALL_NIGHT)).toEqual({ allNight: false, parts: ['9–', '11 PM'] });
    expect(dayLabel({ startMin: 1320, endMin: 1440 }, ALL_NIGHT)).toEqual({ allNight: false, parts: ['10 PM–', '12 AM'] });
  });
});

describe('availability editor: Undo and Discard (ux#B9)', () => {
  const saved = draftFromEntries([{ date: '2026-11-07', ...ALL_NIGHT }]);
  const run = (state: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, state);
  const dates = (state: EditorState) => entriesFromDraft(state.draft).map((e) => e.date);

  it('undoes a whole drag in one step, and a weekday tap in another', () => {
    const dragged = run(
      initEditor(saved),
      { type: 'paint', dates: ['2026-11-09'], range: LATE, stroke: 1 },
      { type: 'paint', dates: ['2026-11-10', '2026-11-11'], range: LATE, stroke: 1 },
      { type: 'strokeEnd', stroke: 1 },
    );
    expect(dates(dragged)).toEqual(['2026-11-07', '2026-11-09', '2026-11-10', '2026-11-11']);
    expect(dragged.history).toHaveLength(1);

    const tapped = run(dragged, { type: 'paint', dates: ['2026-11-14', '2026-11-21'], range: LATE });
    expect(tapped.history).toHaveLength(2);

    const once = editorReducer(tapped, { type: 'undo' });
    expect(once.draft).toBe(dragged.draft);
    const twice = editorReducer(once, { type: 'undo' });
    expect(twice.draft).toBe(saved);
    expect(twice.history).toEqual([]);
    expect(editorReducer(twice, { type: 'undo' })).toBe(twice); // nothing left
  });

  it("doesn't leave an undo step for strokes or taps that changed nothing", () => {
    const start = initEditor(saved);
    // A drag over an already all-night day with the same brush.
    const idle = run(start, { type: 'paint', dates: ['2026-11-07'], range: ALL_NIGHT, stroke: 2 }, { type: 'strokeEnd', stroke: 2 });
    expect(idle.history).toEqual([]);
    expect(idle.stroke).toBeNull();
    // Erasing blank days.
    expect(run(start, { type: 'paint', dates: ['2026-11-20'], range: null })).toBe(start);
    // A stray end for another gesture is ignored.
    expect(editorReducer(start, { type: 'strokeEnd', stroke: 9 })).toBe(start);
  });

  it('Discard returns to the saved draft and can itself be undone', () => {
    const edited = run(initEditor(saved), { type: 'paint', dates: ['2026-11-07'], range: null });
    const discarded = editorReducer(edited, { type: 'discard', saved });
    expect(discarded.draft).toBe(saved);
    expect(editorReducer(discarded, { type: 'discard', saved })).toBe(discarded); // already clean
    expect(editorReducer(discarded, { type: 'undo' }).draft).toBe(edited.draft);
  });

  it('forgets history once saved, keeps at most UNDO_LIMIT steps, and resets on fresh data', () => {
    let state = initEditor(saved);
    for (let day = 1; day <= UNDO_LIMIT + 5; day++) {
      const date = `2026-12-${String((day % 28) + 1).padStart(2, '0')}`;
      state = editorReducer(state, { type: 'paint', dates: [date], range: { startMin: 960 + day, endMin: 1560 } });
    }
    expect(state.history).toHaveLength(UNDO_LIMIT);
    const afterSave = editorReducer(state, { type: 'saved' });
    expect(afterSave.draft).toBe(state.draft);
    expect(afterSave.history).toEqual([]);
    expect(editorReducer(state, { type: 'reset', draft: saved })).toEqual(initEditor(saved));
  });
});
