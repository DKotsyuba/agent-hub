/** Shared class composition for the upstream shadcn/ui components. */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
/** Merge conditional utility classes, resolving Tailwind conflicts without side effects. */
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
