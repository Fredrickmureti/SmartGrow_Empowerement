/**
 * HeldWorkspace — Phase 3b, route-owned surface for `terminalState.phase === "held"`.
 *
 * Replaces `HeldTransactionsDialog` as the on-screen surface for the
 * "Held & Parked Sales" workspace. No `<Dialog>` chrome — this is a
 * workspace body that fills the terminal region provided by
 * `TerminalShell`. Closing dispatches `closeSide`, which restores
 * `previousPhase` via the reducer.
 *
 * Cart-restore is delegated up via `onResume` for now; when the cart
 * moves into terminal context (Phase 5), this workspace will pull the
 * restore action directly and stop taking any props.
 *
 * See `docs/architecture/POS_WORKSTATION_STATES.md`.
 */

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Clock, Trash2, Play, User, ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import { usePOSHeldTransactions, type HeldTransaction } from "@/hooks/pos/usePOSHeldTransactions";
import type { CartState } from "@/hooks/pos/usePOSCart";
import { usePOSSound } from "@/hooks/pos/usePOSSound";
import { useCurrency } from "@/hooks/useCurrency";
import { useTerminalContext } from "../TerminalStateContext";

interface HeldWorkspaceProps {
  registerId: string;
  onResume: (cart: CartState) => void;
}

export function HeldWorkspace({ registerId, onResume }: HeldWorkspaceProps) {
  const { dispatch, state } = useTerminalContext();
  const { heldTransactions, isLoading, resumeTransaction, cancelHeldTransaction } =
    usePOSHeldTransactions(registerId);
  const sound = usePOSSound();
  const { formatCurrency } = useCurrency();

  const close = () => {
    if (state.phase === "held") dispatch({ kind: "op", op: "closeSide" });
  };

  const handleResume = async (tx: HeldTransaction) => {
    try {
      const result = await resumeTransaction.mutateAsync(tx.id);
      onResume(result.items);
      sound.play("recall");
      close();
    } catch {
      sound.play("error");
    }
  };

  const handleCancel = (id: string) => {
    cancelHeldTransaction.mutate(id);
  };

  return (
    <section
      aria-labelledby="held-workspace-title"
      className="absolute inset-0 z-40 flex flex-col bg-background"
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={close} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1
            id="held-workspace-title"
            className="flex items-center gap-2 text-lg font-semibold sm:text-xl"
          >
            <Clock className="h-5 w-5" />
            Held Transactions
            <span className="text-sm font-normal text-muted-foreground">
              ({heldTransactions.length})
            </span>
          </h1>
        </div>
        <Button variant="outline" onClick={close}>
          Close
        </Button>
      </header>

      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : heldTransactions.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <Clock className="mx-auto mb-3 h-12 w-12 opacity-30" />
              <p className="text-sm">No held transactions on this register</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {heldTransactions.map((tx) => (
                <li key={tx.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {tx.customer_name && (
                          <Badge variant="outline" className="text-xs">
                            <User className="mr-1 h-3 w-3" />
                            <span className="truncate max-w-[140px]">{tx.customer_name}</span>
                          </Badge>
                        )}
                        <span className="text-sm text-muted-foreground">
                          {tx.items.items.length} items
                        </span>
                      </div>
                      <p className="mt-1 text-lg font-semibold">
                        {formatCurrency(tx.items.total)}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {format(new Date(tx.held_at), "h:mm a")}
                    </span>
                  </div>

                  {tx.notes && (
                    <p className="truncate text-sm italic text-muted-foreground">{tx.notes}</p>
                  )}

                  <p className="truncate text-sm text-muted-foreground">
                    {tx.items.items.slice(0, 3).map((item, i) => (
                      <span key={i}>
                        {item.name}
                        {item.quantity > 1 && ` (×${item.quantity})`}
                        {i < Math.min(tx.items.items.length - 1, 2) && ", "}
                      </span>
                    ))}
                    {tx.items.items.length > 3 && (
                      <span> ... +{tx.items.items.length - 3} more</span>
                    )}
                  </p>

                  <div className="flex gap-2">
                    <Button
                      className="flex-1 h-11"
                      onClick={() => handleResume(tx)}
                      disabled={resumeTransaction.isPending}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      Resume
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-11 w-11"
                      onClick={() => handleCancel(tx.id)}
                      disabled={cancelHeldTransaction.isPending}
                      aria-label="Cancel held transaction"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
