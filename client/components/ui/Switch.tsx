import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label to the right of the switch (clickable). */
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

/** On/off toggle (role="switch"), e.g. "Available today only", "Show archived". */
export function Switch({ checked, onCheckedChange, label, disabled, className, id, ...aria }: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  return (
    <span className={cn('inline-flex items-center gap-2', disabled && 'opacity-50', className)}>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={aria['aria-label']}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-accent-solid' : 'bg-surface-3',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block size-4 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
      {label && (
        <label htmlFor={switchId} className="text-sm text-fg select-none">
          {label}
        </label>
      )}
    </span>
  );
}
