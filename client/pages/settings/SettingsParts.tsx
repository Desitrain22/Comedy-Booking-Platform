/** Small building blocks shared by the Settings tabs. */
import { AlertTriangle, Check, CheckCircle2, Copy, Info, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, CardFooter, EmptyState, Input } from '../../components/ui';
import { cn } from '../../lib/cn';

// ---------------------------------------------------------------------------
// Save bar
// ---------------------------------------------------------------------------

export interface SaveFooterProps {
  dirty: boolean;
  saving: boolean;
  onDiscard: () => void;
  /** Extra buttons on the left (e.g. "Disconnect"). */
  start?: ReactNode;
  /** Extra buttons before Save (e.g. "Send test email"). */
  end?: ReactNode;
  saveLabel?: string;
}

/** Card footer with an "Unsaved changes" note, Discard and a submit button (wrap in a <form>). */
export function SaveFooter({ dirty, saving, onDiscard, start, end, saveLabel = 'Save changes' }: SaveFooterProps) {
  return (
    <CardFooter className="flex-wrap justify-between gap-y-2">
      <div className="flex min-w-0 items-center gap-2">{start}</div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && (
          <>
            <span className="flex items-center gap-1.5 text-xs text-fg-muted" role="status">
              <span aria-hidden className="size-1.5 rounded-full bg-awaiting" />
              Unsaved changes
            </span>
            <Button variant="ghost" onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
          </>
        )}
        {end}
        <Button type="submit" loading={saving} disabled={!dirty}>
          {saveLabel}
        </Button>
      </div>
    </CardFooter>
  );
}

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

const CALLOUT_STYLES = {
  info: { box: 'border-border bg-surface-2/60 text-fg', icon: Info, iconClass: 'text-fg-muted' },
  success: {
    box: 'border-confirmed/30 bg-confirmed-soft text-confirmed-fg',
    icon: CheckCircle2,
    iconClass: 'text-confirmed',
  },
  warning: {
    box: 'border-awaiting/30 bg-awaiting-soft text-awaiting-fg',
    icon: AlertTriangle,
    iconClass: 'text-awaiting',
  },
  danger: {
    box: 'border-unconfirmed/30 bg-unconfirmed-soft text-unconfirmed-fg',
    icon: AlertTriangle,
    iconClass: 'text-unconfirmed',
  },
} as const;

export interface CalloutProps {
  tone?: keyof typeof CALLOUT_STYLES;
  title?: ReactNode;
  children?: ReactNode;
  icon?: typeof Info;
  className?: string;
  /** Announce to screen readers when it appears (results of an action). */
  live?: boolean;
}

export function Callout({ tone = 'info', title, children, icon, className, live }: CalloutProps) {
  const style = CALLOUT_STYLES[tone];
  const Icon = icon ?? style.icon;
  return (
    <div
      role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}
      className={cn('flex gap-3 rounded-lg border px-3.5 py-3 text-sm', style.box, className)}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', style.iconClass)} />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="leading-relaxed [&_a]:font-medium [&_a]:underline">{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copyable value
// ---------------------------------------------------------------------------

/** Copy to the clipboard; falls back to a selection copy outside secure contexts (plain http). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

export interface CopyButtonProps {
  value: string;
  /** What is copied, for the accessible name ("Copy invite link"). */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** A "Copy" button that flips to "Copied" for a moment. */
export function CopyButton({ value, label, size = 'md', className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast.info('Select the text and press Ctrl+C (or ⌘C) to copy');
    }
  }
  return (
    <Button
      variant="secondary"
      size={size}
      onClick={() => void handleCopy()}
      aria-label={`Copy ${label.toLowerCase()}`}
      className={className}
    >
      {copied ? <Check className="text-confirmed" aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  );
}

export interface CopyFieldProps {
  value: string;
  /** Accessible label for the read-only input (unless a <Field> labels it via `id`). */
  label: string;
  className?: string;
  mono?: boolean;
  /** Set by <Field> so its label and hint describe the input. */
  id?: string;
  'aria-describedby'?: string;
}

/** A read-only input with a Copy button (invite links, links in emails). */
export function CopyField({ value, label, className, mono = true, id, ...aria }: CopyFieldProps) {
  return (
    <div className={cn('flex gap-2', className)}>
      <Input
        readOnly
        value={value}
        id={id}
        aria-label={id ? undefined : label}
        aria-describedby={aria['aria-describedby']}
        onFocus={(e) => e.currentTarget.select()}
        className={cn('min-w-0 flex-1 bg-surface-2/60', mono && 'font-mono text-xs sm:text-xs')}
      />
      <CopyButton value={value} label={label} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color swatches
// ---------------------------------------------------------------------------

export interface ColorSwatchesProps {
  value: string;
  onChange: (color: string) => void;
  palette: readonly string[];
  label: string;
}

/** A row of color choices (radio group). */
export function ColorSwatches({ value, onChange, palette, label }: ColorSwatchesProps) {
  const current = value.toLowerCase();
  const colors = palette.some((c) => c.toLowerCase() === current) ? palette : [...palette, value];
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {colors.map((color) => {
        const selected = color.toLowerCase() === current;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color}
            onClick={() => onChange(color)}
            className={cn(
              'flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition',
              selected ? 'ring-2 ring-fg' : 'hover:scale-110',
            )}
            style={{ backgroundColor: color }}
          >
            {selected && <Check aria-hidden className="size-4 text-white drop-shadow" />}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Shown when a booker (not an admin) opens an admin-only tab. */
export function AdminOnly({ what }: { what: string }) {
  return (
    <EmptyState
      icon={Lock}
      title="Admins only"
      description={`Only club admins can manage ${what}. Ask an admin if you need a change.`}
    />
  );
}
