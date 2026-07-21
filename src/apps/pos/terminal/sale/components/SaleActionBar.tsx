import {
  Trash2,
  Split,
  RotateCcw,
  Receipt,
  Pause,
  Play,
  Tag,
  Banknote,
  CreditCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { usePOSCartAdapter } from "@/hooks/pos/usePOSCartAdapter";

type Cart = ReturnType<typeof usePOSCartAdapter>;

/**
 * Semantic callback surface for SaleActionBar.
 *
 * Extracted (Step 6.2b) instead of threading 15 raw setState/mutation
 * bindings so the button grid stays a pure presentational component and
 * remains reusable inside `SaleWorkspace` once cart-owning routes land.
 */
export interface SaleActionBarCallbacks {
  onClearCart: () => void;
  onSplitBill: () => void;
  onTransferTable: () => void;
  onPrintBill: () => void;
  onHold: () => void;
  onRecallHeld: () => void;
  onDiscount: () => void;
  onOpenPayment: () => void;
}

export interface SaleActionBarProps {
  cart: Cart;
  isTableSession: boolean;
  canHold: boolean;
  heldCount: number;
  formatCurrency: (value: number) => string;
  callbacks: SaleActionBarCallbacks;
}

/**
 * SaleActionBar — desktop cart action grid + quick-pay + primary pay button.
 * Pure prop-driven. Extracted from POSTerminal.tsx (Step 6.2b).
 */
export function SaleActionBar({
  cart,
  isTableSession,
  canHold,
  heldCount,
  formatCurrency,
  callbacks,
}: SaleActionBarProps) {
  const cartEmpty = cart.items.length === 0;

  return (
    <>
      {/* Action Buttons */}
      <div className={cn("grid gap-1.5 xl:gap-2", isTableSession ? "grid-cols-5" : "grid-cols-4")}>
        <Button
          variant="outline"
          className="flex-col h-auto py-2 xl:py-3 px-1"
          onClick={callbacks.onClearCart}
          disabled={cartEmpty}
        >
          <Trash2 className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
          <span className="text-[10px] xl:text-xs">Clear</span>
        </Button>
        {isTableSession ? (
          <>
            <Button
              variant="outline"
              className="flex-col h-auto py-2 xl:py-3 px-1"
              disabled={cartEmpty}
              onClick={callbacks.onSplitBill}
            >
              <Split className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
              <span className="text-[10px] xl:text-xs">Split</span>
            </Button>
            <Button
              variant="outline"
              className="flex-col h-auto py-2 xl:py-3 px-1"
              onClick={callbacks.onTransferTable}
            >
              <RotateCcw className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
              <span className="text-[10px] xl:text-xs">Transfer</span>
            </Button>
            <Button
              variant="outline"
              className="flex-col h-auto py-2 xl:py-3 px-1"
              disabled={cartEmpty}
              onClick={callbacks.onPrintBill}
            >
              <Receipt className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
              <span className="text-[10px] xl:text-xs">Bill</span>
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              className="flex-col h-auto py-2 xl:py-3 px-1 relative"
              disabled={cartEmpty || !canHold}
              onClick={callbacks.onHold}
            >
              <Pause className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
              <span className="text-[10px] xl:text-xs">Hold</span>
            </Button>
            <Button
              variant="outline"
              className="flex-col h-auto py-2 xl:py-3 px-1 relative"
              onClick={callbacks.onRecallHeld}
            >
              <Play className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
              <span className="text-[10px] xl:text-xs">Recall</span>
              {heldCount > 0 && (
                <Badge className="absolute -top-1 -right-1 h-4 w-4 xl:h-5 xl:w-5 p-0 text-[10px] xl:text-xs">
                  {heldCount}
                </Badge>
              )}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          className="flex-col h-auto py-2 xl:py-3 px-1"
          disabled={cartEmpty}
          onClick={callbacks.onDiscount}
        >
          <Tag className="h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1" />
          <span className="text-[10px] xl:text-xs">Discount</span>
        </Button>
      </div>

      {/* Quick Payment Buttons */}
      {!cartEmpty && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            className="h-10 xl:h-12 text-sm"
            onClick={callbacks.onOpenPayment}
          >
            <Banknote className="h-4 w-4 xl:h-5 xl:w-5 mr-1 xl:mr-2" />
            Cash
          </Button>
          <Button
            variant="secondary"
            className="h-10 xl:h-12 text-sm"
            onClick={callbacks.onOpenPayment}
          >
            <CreditCard className="h-4 w-4 xl:h-5 xl:w-5 mr-1 xl:mr-2" />
            Card
          </Button>
        </div>
      )}

      {/* Pay Button */}
      <Button
        className="w-full h-12 xl:h-14 text-base xl:text-lg"
        disabled={cartEmpty}
        onClick={callbacks.onOpenPayment}
      >
        <CreditCard className="h-4 w-4 xl:h-5 xl:w-5 mr-2" />
        Pay {formatCurrency(cart.total)}
      </Button>
    </>
  );
}