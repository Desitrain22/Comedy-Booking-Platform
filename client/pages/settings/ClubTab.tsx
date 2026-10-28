/** Settings → Club: name, timezone, app URL, all-night default range. */
import { useMemo, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { SettingsDto } from '../../../shared/api/settings';
import { AVAILABILITY_MAX_END, AVAILABILITY_MIN_START } from '../../../shared/availability';
import { formatRange, nowMinutesInTz, timeOptions, todayInTz, formatDateMedium, formatTime } from '../../../shared/time';
import { Button, Card, CardBody, CardHeader, Field, Input, PageSpinner, Select } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { SaveFooter } from './SettingsParts';
import { apiFieldErrors, pick, useDraft, useSaveSettings, useSettings, validateSettingsPatch } from './settingsData';

const CLUB_FIELDS = ['clubName', 'timezone', 'appUrl', 'allNightStartMin', 'allNightEndMin'] as const;
type ClubValues = Pick<SettingsDto, (typeof CLUB_FIELDS)[number]>;

/** Half-hour steps from 4 PM to 2 AM (the range comedians can paint). */
const ALL_NIGHT_OPTIONS = timeOptions(AVAILABILITY_MIN_START, AVAILABILITY_MAX_END, 30);

export function ClubTab() {
  const settings = useSettings();
  if (!settings.data) return <PageSpinner />;
  const values = pick(settings.data, CLUB_FIELDS);
  return <ClubForm key={JSON.stringify(values)} saved={values} effectiveAppUrl={settings.data.effectiveAppUrl} />;
}

function timeZoneLabel(timeZone: string): string {
  try {
    return `${formatDateMedium(todayInTz(timeZone))}, ${formatTime(nowMinutesInTz(timeZone))}`;
  } catch {
    return '';
  }
}

function ClubForm({ saved, effectiveAppUrl }: { saved: ClubValues; effectiveAppUrl: string }) {
  const { draft, set, errors, setErrors, reset, dirty } = useDraft<ClubValues>(saved);
  const save = useSaveSettings({ refreshClub: true });
  const browserOrigin = window.location.origin;

  const timeZones = useMemo(() => {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes(draft.timezone) ? zones : [draft.timezone, ...zones];
  }, [draft.timezone]);

  const endOptions = ALL_NIGHT_OPTIONS.map((o) => ({ ...o, disabled: o.value <= draft.allNightStartMin }));
  const startOptions = ALL_NIGHT_OPTIONS.filter((o) => o.value < AVAILABILITY_MAX_END);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const patch = { ...draft };
    const invalid = validateSettingsPatch(patch);
    if (invalid) return setErrors(invalid);
    // mutateAsync (not mutate callbacks): a successful save re-keys this form.
    try {
      await save.mutateAsync(patch);
      toast.success('Club settings saved');
    } catch (err) {
      const fieldErrors = apiFieldErrors(err);
      if (fieldErrors) setErrors(fieldErrors);
      else toast.error(errorMessage(err));
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate>
      <Card>
        <CardHeader title="Club" description="Shown in emails, on the comedian portal and across the app." />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field label="Club name" error={errors.clubName} className="sm:col-span-2">
            <Input value={draft.clubName} onChange={(e) => set('clubName', e.target.value)} maxLength={100} />
          </Field>

          <Field
            label="Timezone"
            error={errors.timezone}
            hint={`Show dates and the weekly email schedule use this. It's ${timeZoneLabel(draft.timezone)} there now.`}
            className="sm:col-span-2"
          >
            <Select value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} wrapperClassName="sm:max-w-sm">
              {timeZones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="App address"
            error={errors.appUrl}
            className="sm:col-span-2"
            hint={
              <>
                Links in emails (sign-in links, confirmations, invites) start with this — use the address people open
                this app at.
                {!draft.appUrl && ` Blank uses ${effectiveAppUrl}.`}
              </>
            }
            aside={
              draft.appUrl !== browserOrigin ? (
                <Button variant="link" className="text-xs" onClick={() => set('appUrl', browserOrigin)}>
                  Use {browserOrigin}
                </Button>
              ) : undefined
            }
          >
            <Input
              type="url"
              inputMode="url"
              value={draft.appUrl}
              placeholder="https://booking.yourclub.com"
              onChange={(e) => set('appUrl', e.target.value)}
            />
          </Field>

          <fieldset className="space-y-1.5 sm:col-span-2">
            <legend className="text-[13px] font-medium text-fg">“All night” means</legend>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="All night starts"
                value={draft.allNightStartMin}
                options={startOptions}
                onChange={(e) => set('allNightStartMin', Number(e.target.value))}
                wrapperClassName="w-36"
              />
              <span className="text-fg-muted">to</span>
              <Select
                aria-label="All night ends"
                aria-invalid={Boolean(errors.allNightEndMin) || undefined}
                value={draft.allNightEndMin}
                options={endOptions}
                onChange={(e) => set('allNightEndMin', Number(e.target.value))}
                wrapperClassName="w-36"
              />
            </div>
            {errors.allNightEndMin || errors.allNightStartMin ? (
              <p className="text-xs text-danger">{errors.allNightEndMin ?? errors.allNightStartMin}</p>
            ) : (
              <p className="text-xs text-fg-muted">
                The “All night” brush comedians use when marking availability (now{' '}
                {draft.allNightEndMin > draft.allNightStartMin
                  ? formatRange(draft.allNightStartMin, draft.allNightEndMin)
                  : '—'}
                ). Nights already marked keep their times.
              </p>
            )}
          </fieldset>
        </CardBody>
        <SaveFooter dirty={dirty} saving={save.isPending} onDiscard={reset} />
      </Card>
    </form>
  );
}
