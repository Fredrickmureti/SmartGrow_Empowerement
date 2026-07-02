/**
 * Stage D — persistent held-orders strip.
 *
 * Replaces dialog-only access with a horizontal chip bar mounted above the
 * cart. Click a chip to recall the order via the same-shift recall RPC
 * (`recall_pos_held_transaction`) so a held sale cannot be resumed across
 * shifts or after close. Hidden when nothing is held.
 */
import { Clock, Package, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  usePOSHeldTransactions,
  type HeldTransaction,
} from "@/hooks/pos/usePOSHeldTransactions";
import { toast } from "sonner";
import type { CartState } from "@/hooks/pos/usePOSCart";

interface HeldOrdersBarProps {
  registerId: string;
  shiftId: string;
  /** Current cart subtotal — used to confirm overwrite if user has work in progress. */
  hasActiveCart: boolean;
  /** Called once recall succeeds with the recovered cart state. */
  onRecall: (cart: CartState, sourceId: string) => void;
  className?: string;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function HeldOrdersBar({
  registerId,
  shiftId,
  hasActiveCart,
  onRecall,
  className,
}: HeldOrdersBarProps) {
  const { heldTransactions, isLoading, resumeTransaction, cancelHeldTransaction } =
    usePOSHeldTransactions(registerId);

  if (isLoading || heldTransactions.length === 0) return null;

  const handleRecall = async (h: HeldTransaction) => {
    if (hasActiveCart) {
      const ok = window.confirm(
        "Recalling this order will replace the current cart. Continue?",
      );
      if (!ok) return;
    }
    try {
      const result: any = await resumeTransaction.mutateAsync({
        id: h.id,
        shiftId,
      });
      const cart = (result?.items || h.items) as CartState;
      onRecall(cart, h.id);
    } catch (err: any) {
      const msg = String(err?.message || err);
      // Translate the structured RPC errors into cashier-readable feedback.
      if (msg.includes("shift_not_open_for_recall")) {
        toast.error("That shift is closed — held order cannot be recalled.");
      } else if (msg.includes("shift_mismatch")) {
        toast.error("This held order belongs to a different shift.");
      } else if (msg.includes("held_order_already_")) {
        toast.error("That held order has already been recalled or cancelled.");
      } else {
        toast.error(`Recall failed: ${msg}`);
      }
    }
  };

  const handleDiscard = async (id: string) => {
    if (!window.confirm("Discard this held order?")) return;
    try {
      await cancelHeldTransaction.mutateAsync(id);
    } catch {
      // toast handled in mutation
    }
  };

  return (
    <div
      data-testid="held-orders-bar"
      className={cn(
        "border-b border-border bg-muted/40 px-2 py-1.5",
        className,
      )}
    >
      <ScrollArea className="w-full">
        <div className="flex items-center gap-2">
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
            <Package className="h-3.5 w-3.5" />
            Held ({heldTransactions.length})
          </span>
          {heldTransactions.map((h) => (
            <div
              key={h.id}
              className="group flex shrink-0 items-stretch overflow-hidden rounded-md border border-border bg-background shadow-sm"
            >
              <button
                type="button"
                onClick={() => handleRecall(h)}
                className="flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent"
                title={h.notes || "Recall this held order"}
              >
                <span className="text-sm font-medium">
                  {h.customer_name || "Walk-in"}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {(h.items as any)?.total != null
                    ? Number((h.items as any).total).toFixed(2)
                    : "—"}
                </span>
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {relativeTime(h.held_at)}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-auto rounded-none border-l border-border px-1.5 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => handleDiscard(h.id)}
                aria-label="Discard held order"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}