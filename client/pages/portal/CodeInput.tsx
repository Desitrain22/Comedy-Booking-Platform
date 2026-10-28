/**
 * One-time-code entry drawn as 6 boxes. Under the boxes is ONE real, transparent <input>
 * covering them, so autofill (`autocomplete="one-time-code"`), paste ("123 456",
 * "123-456"), screen readers and form labels all work like a normal text field.
 */
import { useState, type ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export interface CodeInputProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> {
  /** Digits only. */
  value: string;
  onChange: (digits: string) => void;
  length?: number;
  invalid?: boolean;
}

export function CodeInput({ value, onChange, length = 6, invalid, className, onFocus, onBlur, ...props }: CodeInputProps) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, length - 1);
  return (
    <div className={cn('relative', className)}>
      <div aria-hidden className="grid gap-2" style={{ gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` }}>
        {Array.from({ length }, (_, i) => {
          const char = value[i];
          const isActive = focused && i === active;
          return (
            <div
              key={i}
              className={cn(
                'flex h-14 items-center justify-center rounded-lg border bg-surface font-mono text-2xl font-semibold text-fg shadow-xs transition-colors',
                isActive ? 'border-accent outline-2 outline-accent/30' : invalid ? 'border-danger' : 'border-border-strong',
              )}
            >
              {char ?? (isActive && <span className="h-7 w-0.5 animate-pulse rounded-full bg-fg" />)}
            </div>
          );
        })}
      </div>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
        onFocus={(e) => {
          setFocused(true);
          // Keep the caret at the end so typing always fills the next box.
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        className="absolute inset-0 size-full cursor-text rounded-lg border-0 bg-transparent text-base text-transparent caret-transparent outline-none selection:bg-transparent"
        {...props}
      />
    </div>
  );
}
