import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Clock, Trash2, Play, User } from "lucide-react";
import { usePOSHeldTransactions, HeldTransaction } from "@/hooks/pos/usePOSHeldTransactions";
import { CartState } from "@/hooks/pos/usePOSCart";
import { format } from "date-fns";
import { usePOSSound } from "@/hooks/pos/usePOSSound";
import { useCurrency } from "@/hooks/useCurrency";

interface HeldTransactionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerId: string;
  onResume: (cart: CartState) => void;
}

export function HeldTransactionsDialog({
  open,
  onOpenChange,
  registerId,
  onResume,
}: HeldTransactionsDialogProps) {
  const { heldTransactions, isLoading, resumeTransaction, cancelHeldTransaction } =
    usePOSHeldTransactions(registerId);
  const sound = usePOSSound();
  const { formatCurrency } = useCurrency();

  const handleResume = async (tx: HeldTransaction) => {
    try {
      const result = await resumeTransaction.mutateAsync(tx.id);
      onResume(result.items);
      sound.play("recall");
      onOpenChange(false);
    } catch (error) {
      sound.play("error");
    }
  };

  const handleCancel = (id: string) => {
    cancelHeldTransaction.mutate(id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Clock className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
            <span>Held ({heldTransactions.length})</span>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 max-h-[60vh] sm:max-h-[400px]">
          {isLoading ? (
            <div className="space-y-2 sm:space-y-3 pr-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-16 sm:h-20 bg-muted animate-pulse rounded-lg"
                />
              ))}
            </div>
          ) : heldTransactions.length === 0 ? (
            <div className="text-center py-8 sm:py-12 text-muted-foreground">
              <Clock className="h-10 w-10 sm:h-12 sm:w-12 mx-auto mb-2 sm:mb-3 opacity-30" />
              <p className="text-sm">No held transactions</p>
            </div>
          ) : (
            <div className="space-y-2 sm:space-y-3 pr-2">
              {heldTransactions.map((tx) => (
                <div
                  key={tx.id}
                  className="p-3 sm:p-4 border rounded-lg space-y-2 sm:space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
                        {tx.customer_name && (
                          <Badge variant="outline" className="text-[10px] sm:text-xs">
                            <User className="h-2 w-2 sm:h-3 sm:w-3 mr-0.5 sm:mr-1" />
                            <span className="truncate max-w-[80px] sm:max-w-none">{tx.customer_name}</span>
                          </Badge>
                        )}
                        <span className="text-xs sm:text-sm text-muted-foreground">
                          {tx.items.items.length} items
                        </span>
                      </div>
                      <p className="text-base sm:text-lg font-semibold mt-0.5 sm:mt-1">
                        {formatCurrency(tx.items.total)}
                      </p>
                    </div>
                    <span className="text-[10px] sm:text-xs text-muted-foreground shrink-0">
                      {format(new Date(tx.held_at), "h:mm a")}
                    </span>
                  </div>

                  {tx.notes && (
                    <p className="text-xs sm:text-sm text-muted-foreground italic truncate">
                      {tx.notes}
                    </p>
                  )}

                  <div className="text-xs sm:text-sm text-muted-foreground truncate">
                    {tx.items.items.slice(0, 2).map((item, i) => (
                      <span key={i}>
                        {item.name}
                        {item.quantity > 1 && ` (×${item.quantity})`}
                        {i < Math.min(tx.items.items.length - 1, 1) && ", "}
                      </span>
                    ))}
                    {tx.items.items.length > 2 && (
                      <span className="text-muted-foreground">
                        ... +{tx.items.items.length - 2} more
                      </span>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      className="flex-1 h-9 sm:h-10 text-xs sm:text-sm"
                      onClick={() => handleResume(tx)}
                      disabled={resumeTransaction.isPending}
                    >
                      <Play className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                      Resume
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 sm:h-10 sm:w-10"
                      onClick={() => handleCancel(tx.id)}
                      disabled={cancelHeldTransaction.isPending}
                    >
                      <Trash2 className="h-3 w-3 sm:h-4 sm:w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
