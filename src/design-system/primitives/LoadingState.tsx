/**
 * LoadingState — the canonical skeleton for in-flight data. Use this
 * inside Section / PageBody instead of ad-hoc spinners.
 */
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

interface LoadingStateProps {
  /** Number of skeleton rows. Default 4. */
  rows?: number;
  className?: string;
}

export function LoadingState({ rows = 4, className }: LoadingStateProps) {
  return (
    <div className={cn("flex flex-col gap-2 py-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-[var(--ds-row-height)] w-full rounded-md"
          style={{ opacity: 1 - i * 0.12 }}
        />
      ))}
    </div>
  );
}
