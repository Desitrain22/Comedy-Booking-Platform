import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names (clsx syntax) and resolve Tailwind conflicts so later classes win:
 * cn('px-2 bg-surface', isActive && 'bg-accent-soft', className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
