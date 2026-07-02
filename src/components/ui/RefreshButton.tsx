import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type RefreshButtonProps = {
  /** Optional tooltip text */
  tooltip?: string;
  /** Optional className */
  className?: string;
} & (
  | {
      /** Query key prefixes to invalidate on click */
      queryKeyPrefixes: readonly (readonly unknown[])[];
      onRefresh?: never;
    }
  | {
      /** Custom async refresh callback (for pages that don't use React Query) */
      onRefresh: () => void | Promise<void>;
      queryKeyPrefixes?: never;
    }
);

/**
 * Reusable section-level refresh button for finance pages.
 *
 * Two modes:
 *   - `queryKeyPrefixes`: invalidates specific React Query caches
 *   - `onRefresh`: calls a custom callback (for hooks that expose their own
 *     refresh function instead of using TanStack Query)
 *
 * Both modes share identical visual UX (spinner, disabled state, tooltip).
 */
export function RefreshButton(props: RefreshButtonProps) {
  const { tooltip = "Refresh data", className } = props;
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      if ("onRefresh" in props && props.onRefresh) {
        await props.onRefresh();
      } else if ("queryKeyPrefixes" in props && props.queryKeyPrefixes) {
        await Promise.all(
          props.queryKeyPrefixes.map((prefix) =>
            queryClient.invalidateQueries({ queryKey: prefix as unknown[] })
          )
        );
      }
    } finally {
      // Keep spinner briefly for visual feedback
      setTimeout(() => setIsRefreshing(false), 400);
    }
  }, [queryClient, props]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className={className}
          aria-label={tooltip}
        >
          <RefreshCw
            className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}
