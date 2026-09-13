import { cn } from '@/lib/utils';

/**
 * SVG country flag (flag-icons). Renders consistently on every platform,
 * unlike emoji flags which don't display on Windows. `code` is an ISO 3166-1
 * alpha-2 country code (case-insensitive).
 */
export function Flag({ code, className }: { code: string | null | undefined; className?: string }) {
  if (!code || code.length !== 2) return null;
  return <span className={cn('fi', `fi-${code.toLowerCase()}`, 'rounded-[2px]', className)} />;
}
