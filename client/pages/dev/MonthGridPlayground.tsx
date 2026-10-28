/**
 * /dev/month-grid — development-only playground for <MonthGrid> (not in production builds).
 * Shows the three ways features use it, and is exercised by e2e/smoke.spec.ts.
 */
import { useRef, useState } from 'react';
import { addMonths, datesForWeekday, formatDateLong, formatMonthLong, monthOf, todayInTz } from '../../../shared/time';
import { MonthGrid, type PaintGesture } from '../../components/MonthGrid';
import { Button, Card, CardBody, CardHeader } from '../../components/ui';

const TODAY = todayInTz(Intl.DateTimeFormat().resolvedOptions().timeZone);

/** F1 create-shows semantics: a drag starting on an unselected day adds, on a selected day removes. */
function ToggleDemo({ month }: { month: string }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const mode = useRef<'add' | 'remove'>('add');
  function onPaint(dates: string[], gesture: PaintGesture) {
    if (gesture.phase === 'start') mode.current = selected.has(gesture.origin) ? 'remove' : 'add';
    setSelected((prev) => {
      const next = new Set(prev);
      for (const d of dates) {
        if (mode.current === 'add') next.add(d);
        else next.delete(d);
      }
      return next;
    });
  }
  return (
    <Card>
      <CardHeader title="Toggle painting (create shows)" description="Drag from an empty day to add, from a selected day to remove." />
      <CardBody>
        <MonthGrid
          month={month}
          today={TODAY}
          isSelected={(d) => selected.has(d)}
          onPaint={onPaint}
          renderDay={(d) => selected.has(d) && <span className="rounded bg-accent-solid px-1 text-[10px] text-white">+ 9:30</span>}
          aria-label="Toggle demo"
          onWeekdayClick={(weekday) =>
            setSelected((prev) => {
              const days = datesForWeekday(month, weekday);
              const allOn = days.every((d) => prev.has(d));
              const next = new Set(prev);
              for (const d of days) {
                if (allOn) next.delete(d);
                else next.add(d);
              }
              return next;
            })
          }
        />
        <p className="mt-3 text-sm text-fg-muted" data-testid="toggle-count">
          {selected.size} selected
        </p>
      </CardBody>
    </Card>
  );
}

/** F4 portal semantics: every covered day gets the brush; past days are disabled. */
function BrushDemo({ month }: { month: string }) {
  const [painted, setPainted] = useState<ReadonlyMap<string, string>>(new Map());
  const [brush, setBrush] = useState<string | null>('All night');
  return (
    <Card>
      <CardHeader
        title="Brush painting (portal)"
        description="Every day you touch gets the brush. Past days are disabled."
        actions={
          <div className="flex gap-1">
            {['All night', '9–11 PM'].map((b) => (
              <Button key={b} size="sm" variant={brush === b ? 'primary' : 'secondary'} onClick={() => setBrush(b)}>
                {b}
              </Button>
            ))}
            <Button size="sm" variant={brush === null ? 'primary' : 'secondary'} onClick={() => setBrush(null)}>
              Not available
            </Button>
          </div>
        }
      />
      <CardBody>
        <MonthGrid
          month={month}
          today={TODAY}
          weekdayLabels="mini"
          cellClassName="min-h-14"
          isDisabled={(d) => d < TODAY}
          onPaint={(dates) =>
            setPainted((prev) => {
              const next = new Map(prev);
              for (const d of dates) {
                if (brush) next.set(d, brush);
                else next.delete(d);
              }
              return next;
            })
          }
          dayClassName={(d) => painted.has(d) && 'border-available bg-available-soft'}
          renderDay={(d) =>
            painted.has(d) && <span className="text-[10px] leading-tight font-semibold text-available-fg">{painted.get(d)}</span>
          }
          aria-label="Brush demo"
        />
        <p className="mt-3 text-sm text-fg-muted" data-testid="brush-count">
          {painted.size} nights marked
        </p>
      </CardBody>
    </Card>
  );
}

/** F1 month calendar / F3 read-only view: click a day. */
function ClickDemo({ month }: { month: string }) {
  const [clicked, setClicked] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Click mode (month calendar)" description="Clicking a day calls onDayClick; inner buttons don't." />
      <CardBody>
        <MonthGrid
          month={month}
          today={TODAY}
          cellClassName="min-h-20"
          onDayClick={setClicked}
          renderDay={(d) =>
            d.endsWith('5') && (
              <button
                type="button"
                className="truncate rounded border-l-2 border-[#7c5cff] bg-surface-2 px-1 text-left text-[10px] hover:bg-surface-3"
                onClick={() => setClicked(`pill on ${d}`)}
              >
                7:30 · Cellar · 5/7
              </button>
            )
          }
          aria-label="Click demo"
        />
        <p className="mt-3 text-sm text-fg-muted" data-testid="clicked">
          {clicked ? (clicked.startsWith('pill') ? clicked : formatDateLong(clicked)) : 'Nothing clicked'}
        </p>
      </CardBody>
    </Card>
  );
}

export function MonthGridPlayground() {
  const [month, setMonth] = useState(monthOf(TODAY));
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">MonthGrid playground · {formatMonthLong(month)}</h1>
        <Button variant="secondary" size="sm" onClick={() => setMonth(addMonths(month, -1))}>
          Prev
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setMonth(addMonths(month, 1))}>
          Next
        </Button>
      </div>
      <ToggleDemo month={month} />
      <BrushDemo month={month} />
      <ClickDemo month={month} />
    </div>
  );
}
