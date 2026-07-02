/**
 * StockAvailabilityIndicator
 *
 * Single source of truth for how product stock is communicated in
 * sales-side line editors (invoices, sales orders, estimates, POS).
 *
 * Design principles:
 *  - Healthy stock is quiet (muted pill). Visual shouting is reserved for
 *    LOW / OUT / EXCEEDED states so warnings actually land.
 *  - Non-tracked products (services / track_inventory=false) render NOTHING.
 *    We never imply a stock contract we don't keep.
 *  - All colors come from semantic tokens (success/warning/destructive).
 *    No raw color classes.
 */
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, PackageX, PackageCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export type StockStatus = "untracked" | "out" | "exceeded" | "zero-after" | "low" | "ok";

export interface StockEvalInput {
  trackInventory?: boolean | null;
  productType?: "product" | "service" | string | null;
  onHand?: number | null;
  reorderLevel?: number | null;
  requestedQty?: number | null;
}

export interface StockEvalResult {
  status: StockStatus;
  onHand: number;
  remainingAfter: number;
  shortBy: number;
  message: string;
}

export function evaluateStock(input: StockEvalInput): StockEvalResult {
  const tracked = input.trackInventory === true && input.productType !== "service";
  const onHand = Number(input.onHand ?? 0);
  const requested = Number(input.requestedQty ?? 0);
  const reorder = Number(input.reorderLevel ?? 0);
  const remainingAfter = onHand - requested;
  const shortBy = requested - onHand;

  if (!tracked) {
    return {
      status: "untracked",
      onHand,
      remainingAfter,
      shortBy: 0,
      message: "Not stock-tracked",
    };
  }

  if (onHand <= 0) {
    return {
      status: "out",
      onHand,
      remainingAfter,
      shortBy,
      message: "Out of stock",
    };
  }

  if (requested > onHand) {
    return {
      status: "exceeded",
      onHand,
      remainingAfter,
      shortBy,
      message: `Only ${onHand} in stock — short by ${shortBy}`,
    };
  }

  if (requested > 0 && requested === onHand) {
    return {
      status: "zero-after",
      onHand,
      remainingAfter,
      shortBy: 0,
      message: `This will zero out stock (${onHand} → 0)`,
    };
  }

  if (reorder > 0 && remainingAfter <= reorder) {
    return {
      status: "low",
      onHand,
      remainingAfter,
      shortBy: 0,
      message:
        requested > 0
          ? `Low stock — ${remainingAfter} will remain (reorder at ${reorder})`
          : `Low stock — ${onHand} on hand (reorder at ${reorder})`,
    };
  }

  return {
    status: "ok",
    onHand,
    remainingAfter,
    shortBy: 0,
    message: requested > 0 ? `${remainingAfter} remaining after this line` : `${onHand} in stock`,
  };
}

/**
 * Compact pill — for use inside a <SelectItem> next to the product name.
 * Stays quiet for healthy stock; loud for low / out.
 */
export function StockBadge({
  trackInventory,
  productType,
  onHand,
  reorderLevel,
  className,
}: Omit<StockEvalInput, "requestedQty"> & { className?: string }) {
  const evalResult = evaluateStock({ trackInventory, productType, onHand, reorderLevel });
  if (evalResult.status === "untracked") return null;

  if (evalResult.status === "out") {
    return (
      <Badge variant="destructive" className={cn("h-5 max-w-full px-1.5 text-[10px] font-medium gap-1 whitespace-nowrap", className)}>
        <PackageX className="h-3 w-3" />
        Out of stock
      </Badge>
    );
  }

  if (evalResult.status === "low") {
    return (
      <Badge
        className={cn(
          "h-5 max-w-full px-1.5 text-[10px] font-medium gap-1 whitespace-nowrap bg-warning text-warning-foreground hover:bg-warning/90",
          className,
        )}
      >
        <AlertTriangle className="h-3 w-3" />
        Low: {evalResult.onHand}
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className={cn("h-5 max-w-full px-1.5 text-[10px] font-medium whitespace-nowrap", className)}>
      In stock: {evalResult.onHand}
    </Badge>
  );
}

/**
 * Inline status chip + message — for use beneath a selected line, where
 * we can react live to the user-entered quantity.
 */
export function StockLineStatus({
  trackInventory,
  productType,
  onHand,
  reorderLevel,
  requestedQty,
  className,
}: StockEvalInput & { className?: string }) {
  const evalResult = evaluateStock({ trackInventory, productType, onHand, reorderLevel, requestedQty });
  if (evalResult.status === "untracked") return null;

  const tone =
    evalResult.status === "exceeded" || evalResult.status === "out"
      ? "destructive"
      : evalResult.status === "low" || evalResult.status === "zero-after"
        ? "warning"
        : "ok";

  const Icon =
    tone === "destructive" ? PackageX : tone === "warning" ? AlertTriangle : PackageCheck;

  return (
    <div
      className={cn(
        "flex max-w-full min-w-0 items-center gap-1.5 text-xs rounded-md px-2 py-1 border",
        tone === "destructive" &&
          "bg-destructive/10 text-destructive border-destructive/30",
        tone === "warning" && "bg-warning/15 text-warning-foreground border-warning/40",
        tone === "ok" && "bg-muted text-muted-foreground border-border",
        className,
      )}
      role={tone === "destructive" ? "alert" : undefined}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words font-medium">{evalResult.message}</span>
    </div>
  );
}
