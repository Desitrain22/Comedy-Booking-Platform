import { useId, type ReactNode } from 'react';

export interface SendLinkCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Plural copy for Bulk add. */
  many?: boolean;
  /** Overrides the label ("Email each new comedian a sign-in link"). */
  label?: ReactNode;
}

/** "Email them a sign-in link" — on by default when adding comedians. */
export function SendLinkCheckbox({ checked, onChange, many = false, label }: SendLinkCheckboxProps) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5 size-4 shrink-0 rounded accent-accent-solid"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-fg">
          {label ?? `Email ${many ? 'each of them' : 'them'} a sign-in link`}
        </label>
        <p id={`${id}-hint`} className="text-xs text-fg-muted">
          It opens the comedian portal, where they mark their availability and see their spots. No password needed.
        </p>
      </div>
    </div>
  );
}
