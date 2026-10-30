/**
 * Settings → Confirmations: the weekly "please confirm your spots" email schedule, the
 * daily catch-up for late bookings (catchUpEnabled) and whether comedians may decline
 * single spots (allowDeclines, shown to comedians via club info → refreshes /auth/me).
 */
import { CalendarClock } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { toast } from 'sonner';
import type { SettingsDto } from '../../../shared/api/settings';
import { formatDateLong, formatDateShort, formatTime, timeOptions, WEEKDAY_NAMES } from '../../../shared/time';
import { Card, CardBody, CardHeader, Field, PageSpinner, Select, Switch } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { nextConfirmationSend } from './confirmationSchedule';
import { Callout, SaveFooter } from './SettingsParts';
import { apiFieldErrors, pick, useDraft, useSaveSettings, useSettings, validateSettingsPatch } from './settingsData';

const FIELDS = ['confirmationsEnabled', 'confirmationDay', 'confirmationTimeMin', 'catchUpEnabled', 'allowDeclines'] as const;
type ConfirmationValues = Pick<SettingsDto, (typeof FIELDS)[number]>;

const DAY_OPTIONS = WEEKDAY_NAMES.map((name, value) => ({ value, label: name }));
/** Every 15 minutes, midnight to 11:45 PM. */
const TIME_OPTIONS = timeOptions(0, 1425, 15);

/** "Nov 2–8", or "Nov 30–Dec 6" across months. */
function formatWeekRange(start: string, end: string): string {
  const [startMonth, startDay] = formatDateShort(start).split(' ');
  const [endMonth, endDay] = formatDateShort(end).split(' ');
  return startMonth === endMonth ? `${startMonth} ${startDay}–${endDay}` : `${startMonth} ${startDay}–${endMonth} ${endDay}`;
}

export function ConfirmationsTab() {
  const settings = useSettings();
  if (!settings.data) return <PageSpinner />;
  const values = pick(settings.data, FIELDS);
  return (
    <ConfirmationsForm
      key={JSON.stringify(values)}
      saved={values}
      timeZone={settings.data.timezone}
      emailConfigured={settings.data.emailConfigured}
      sentWeeks={settings.data.confirmationWeeksSent}
    />
  );
}

interface ConfirmationsFormProps {
  saved: ConfirmationValues;
  timeZone: string;
  emailConfigured: boolean;
  sentWeeks: string[];
}

function ConfirmationsForm({ saved, timeZone, emailConfigured, sentWeeks }: ConfirmationsFormProps) {
  const { draft, set, errors, setErrors, reset, dirty } = useDraft<ConfirmationValues>(saved);
  // allowDeclines is club info (useClub()): refresh /auth/me after saving.
  const save = useSaveSettings({ refreshClub: true });
  const next = nextConfirmationSend({
    day: draft.confirmationDay,
    timeMin: draft.confirmationTimeMin,
    timeZone,
    sentWeeks,
  });
  // A due send that never went out (the schedule is being changed, or switched on): the
  // scheduler sends it on its next tick, so say so before the booker saves.
  const scheduleChanged =
    draft.confirmationsEnabled !== saved.confirmationsEnabled ||
    draft.confirmationDay !== saved.confirmationDay ||
    draft.confirmationTimeMin !== saved.confirmationTimeMin;
  const timeOptionsWithSaved = TIME_OPTIONS.some((o) => o.value === draft.confirmationTimeMin)
    ? TIME_OPTIONS
    : [...TIME_OPTIONS, { value: draft.confirmationTimeMin, label: formatTime(draft.confirmationTimeMin) }].sort(
        (a, b) => a.value - b.value,
      );
  const sameWeek = next.date === next.weekStart;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateSettingsPatch(draft);
    if (invalid) return setErrors(invalid);
    // mutateAsync (not mutate callbacks): a successful save re-keys this form.
    try {
      const s = await save.mutateAsync(draft);
      toast.success(
        s.confirmationsEnabled || saved.confirmationsEnabled === s.confirmationsEnabled
          ? 'Confirmation settings saved'
          : 'Automatic confirmations turned off',
      );
    } catch (err) {
      const fieldErrors = apiFieldErrors(err);
      if (fieldErrors) setErrors(fieldErrors);
      else toast.error(errorMessage(err));
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate>
      <Card>
        <CardHeader
          title="Weekly confirmations"
          description="Once a week, every comedian booked that week gets one email listing their spots with a “Confirm my spots” button."
        />
        <CardBody className="space-y-5">
          <Switch
            checked={draft.confirmationsEnabled}
            onCheckedChange={(v) => set('confirmationsEnabled', v)}
            label="Send confirmation emails automatically"
          />

          <div className={cn('grid gap-4 sm:grid-cols-2', !draft.confirmationsEnabled && 'opacity-60')}>
            <Field label="Day" error={errors.confirmationDay}>
              <Select
                value={draft.confirmationDay}
                options={DAY_OPTIONS}
                disabled={!draft.confirmationsEnabled}
                onChange={(e) => set('confirmationDay', Number(e.target.value))}
              />
            </Field>
            <Field label="Time" error={errors.confirmationTimeMin} hint={`Club time (${timeZone.replace(/_/g, ' ')}).`}>
              <Select
                value={draft.confirmationTimeMin}
                options={timeOptionsWithSaved}
                disabled={!draft.confirmationsEnabled}
                onChange={(e) => set('confirmationTimeMin', Number(e.target.value))}
              />
            </Field>
          </div>

          {draft.confirmationsEnabled && next.overdue ? (
            <Callout
              icon={CalendarClock}
              tone={scheduleChanged ? 'warning' : undefined}
              title={
                scheduleChanged
                  ? `Saving sends the email for ${formatWeekRange(next.weekStart, next.weekEnd)} right away`
                  : `Sending the email for ${formatWeekRange(next.weekStart, next.weekEnd)} now`
              }
            >
              With this schedule it was due {formatDateLong(next.date)} at {formatTime(draft.confirmationTimeMin)} and
              hasn’t gone out, so it goes out {scheduleChanged ? 'within a minute of saving' : 'within a minute'} — only
              to comedians who haven’t been emailed about their spots that week. After that: every{' '}
              {WEEKDAY_NAMES[draft.confirmationDay]} at {formatTime(draft.confirmationTimeMin)}.
            </Callout>
          ) : draft.confirmationsEnabled ? (
            <Callout icon={CalendarClock} title={`Next automatic send: ${formatDateLong(next.date)} at ${formatTime(draft.confirmationTimeMin)}`}>
              Every {WEEKDAY_NAMES[draft.confirmationDay]} at {formatTime(draft.confirmationTimeMin)}, comedians booked for{' '}
              {sameWeek ? 'that week' : 'the following week'} (Monday–Sunday) get their email — the next one covers{' '}
              {formatWeekRange(next.weekStart, next.weekEnd)}.
            </Callout>
          ) : (
            <Callout title="Automatic confirmations are off">
              Nothing is sent on a schedule. You can still send confirmations by hand from the Dashboard.
            </Callout>
          )}
          {!emailConfigured && (
            <Callout tone="warning" title="Email isn’t set up yet">
              Confirmation emails will land in the outbox (Settings → Email) until you connect an email provider.
            </Callout>
          )}

          <div className="space-y-5 border-t border-border pt-5">
            <SwitchRow
              checked={draft.confirmationsEnabled && draft.catchUpEnabled}
              onCheckedChange={(v) => set('catchUpEnabled', v)}
              disabled={!draft.confirmationsEnabled}
              label="Email late bookings daily"
            >
              {draft.confirmationsEnabled ? (
                <>
                  Spots booked after this week’s email went out get their own email every day at{' '}
                  {formatTime(draft.confirmationTimeMin)} — only comedians with a spot this week they haven’t been
                  emailed about. Off: send those by hand from the Dashboard.
                </>
              ) : (
                'Needs automatic confirmations (above).'
              )}
            </SwitchRow>
            <SwitchRow
              checked={draft.allowDeclines}
              onCheckedChange={(v) => set('allowDeclines', v)}
              label="Let comedians decline individual spots"
            >
              {draft.allowDeclines ? (
                <>
                  Each spot in the email and the portal gets a “Can’t make it” option (with an optional note). A declined
                  spot stays in the lineup, struck through as Declined, so you can book a replacement.
                </>
              ) : (
                <>
                  Comedians confirm their whole week at once; to drop a spot they reply to the email (replies go to your
                  Reply-To address, or the first admin if none is set).
                </>
              )}
            </SwitchRow>
          </div>
        </CardBody>
        <SaveFooter dirty={dirty} saving={save.isPending} onDiscard={reset} />
      </Card>
    </form>
  );
}

/** A switch with its help text underneath, aligned with the label. */
function SwitchRow({
  checked,
  onCheckedChange,
  disabled,
  label,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} label={label} />
      <p className={cn('mt-1 pl-11 text-xs leading-relaxed text-fg-muted', disabled && 'opacity-60')}>
        {children}
      </p>
    </div>
  );
}
