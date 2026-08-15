import { useRef, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  formatBaseQty,
  formatQtyAsPacks,
  type PackForRollup,
} from "@/lib/inventory/formatQty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";

interface StockCellProps {
  value: number;
  reorderLevel?: number | null;
  /** When false, render a dim em-dash — the product is not stock-tracked. */
  trackInventory?: boolean;
  /** Optional pack rows for "10 Box (240 ea)" rollup. */
  packs?: PackForRollup[];
  /** Base UoM label, e.g. "ea", "kg". Defaults to "ea". */
  baseLabel?: string;
  /** When true, render a skeleton instead of the value — the on-hand
   *  quantity is still loading and `value` is not yet meaningful. Prevents
   *  the misleading "0 (Out)" flicker on two-phase fetches. */
  isLoading?: boolean;
  className?: string;
}

/**
 * Listing-row stock cell. Single source of truth for how on-hand quantities
 * render in inventory & product list tables: pack-aware rollup, flash on
 * change, low / out chips, and a "not tracked" dim em-dash for service /
 * non-inventory products.
 */
export function StockCell({
  value,
  reorderLevel,
  trackInventory = true,
  packs,
  baseLabel = "ea",
  isLoading = false,
  className,
}: StockCellProps) {
  const prevValue = useRef(value);
  const [flashType, setFlashType] = useState<"increase" | "decrease" | null>(null);

  useEffect(() => {
    if (prevValue.current !== value) {
      const type = value > prevValue.current ? "increase" : "decrease";
      setFlashType(type);
      const timer = setTimeout(() => setFlashType(null), 1500);
      prevValue.current = value;
      return () => clearTimeout(timer);
    }
  }, [value]);

  if (isLoading) {
    return (
      <Skeleton
        className={cn("inline-block h-4 w-12 align-middle", className)}
        aria-label="Loading stock"
      />
    );
  }

  if (trackInventory === false) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("text-muted-foreground", className)}>—</span>
        </TooltipTrigger>
        <TooltipContent>Not stock-tracked</TooltipContent>
      </Tooltip>
    );
  }

  const isLow = reorderLevel && reorderLevel > 0 && value <= reorderLevel;
  const isOutOfStock = value <= 0;
  const hasPacks = packs && packs.length > 0 && value > 0;
  const packLabel = hasPacks ? formatQtyAsPacks(value, packs!, baseLabel) : null;
  const baseLabelText = formatBaseQty(value, baseLabel);
  const showRollup = packLabel && packLabel !== baseLabelText;

  return (
    <span
      className={cn(
        "inline-flex flex-col items-end leading-tight px-2 py-0.5 rounded transition-all duration-300",
        isOutOfStock && "text-destructive font-medium",
        isLow && !isOutOfStock && "text-warning font-medium",
        flashType === "decrease" && "bg-destructive/20 animate-pulse",
        flashType === "increase" && "bg-success/20 animate-pulse",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1">
        {baseLabelText}
        {isLow && !isOutOfStock && (
          <span className="text-xs opacity-70">(Low)</span>
        )}
        {isOutOfStock && <span className="text-xs opacity-70">(Out)</span>}
      </span>
      {showRollup && (
        <span className="text-[10px] font-normal text-muted-foreground">
          {/* "= 8 × 50 kg Bag" reads as a rollup of the base figure above,
              not as a second, unrelated quantity. */}
          {`= ${packLabel.replace(/^(\d+(?:\.\d+)?)\s/, "$1 × ")}`}
        </span>
      )}
    </span>
  );
}
