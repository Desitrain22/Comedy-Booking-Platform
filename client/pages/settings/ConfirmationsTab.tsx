/** Settings → Confirmations: the weekly "please confirm your spots" email schedule. */
import { CalendarClock } from 'lucide-react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import type { SettingsDto } from '../../../shared/api/settings';
import { formatDateLong, formatDateShort, formatTime, timeOptions, WEEKDAY_NAMES } from '../../../shared/time';
import { Card, CardBody, CardHeader, Field, PageSpinner, Select, Switch } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { nextConfirmationSend } from './confirmationSchedule';
import { Callout, SaveFooter } from './SettingsParts';
import { apiFieldErrors, pick, useDraft, useSaveSettings, useSettings, validateSettingsPatch } from './settingsData';

const FIELDS = ['confirmationsEnabled', 'confirmationDay', 'confirmationTimeMin'] as const;
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
    />
  );
}

interface ConfirmationsFormProps {
  saved: ConfirmationValues;
  timeZone: string;
  emailConfigured: boolean;
}

function ConfirmationsForm({ saved, timeZone, emailConfigured }: ConfirmationsFormProps) {
  const { draft, set, errors, setErrors, reset, dirty } = useDraft<ConfirmationValues>(saved);
  const save = useSaveSettings();
  const next = nextConfirmationSend({ day: draft.confirmationDay, timeMin: draft.confirmationTimeMin, timeZone });
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
      toast.success(s.confirmationsEnabled ? 'Confirmation schedule saved' : 'Automatic confirmations turned off');
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

          {draft.confirmationsEnabled ? (
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
        </CardBody>
        <SaveFooter dirty={dirty} saving={save.isPending} onDiscard={reset} />
      </Card>
    </form>
  );
}
