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
  /**
   * `desktop` (default) renders the responsive `xl:` sizing + quick-pay
   * (Cash / Card) row used inside the sale-phase right rail.
   *
   * `mobile` renders the compact grid used inside the mobile cart
   * drawer: no quick-pay row, Print-Bill label instead of "Bill", no
   * `xl:` size ramps. Kept as a single component so behaviour and
   * disabled-state logic cannot drift between the two mount points.
   */
  variant?: "desktop" | "mobile";
  /**
   * Fired after any action callback resolves. Used by the mobile
   * drawer to auto-dismiss after the user commits to an action — the
   * desktop mount leaves this undefined.
   */
  onAfterAction?: () => void;
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
  variant = "desktop",
  onAfterAction,
}: SaleActionBarProps) {
  const cartEmpty = cart.items.length === 0;
  const isMobile = variant === "mobile";
  const wrap = (fn: () => void) => () => {
    fn();
    onAfterAction?.();
  };
  const btnCls = isMobile
    ? "flex-col h-auto py-2 px-1"
    : "flex-col h-auto py-2 xl:py-3 px-1";
  const btnRelCls = isMobile
    ? "flex-col h-auto py-2 px-1 relative"
    : "flex-col h-auto py-2 xl:py-3 px-1 relative";
  const iconCls = isMobile
    ? "h-4 w-4 mb-0.5"
    : "h-4 w-4 xl:h-5 xl:w-5 mb-0.5 xl:mb-1";
  const labelCls = isMobile ? "text-[10px]" : "text-[10px] xl:text-xs";
  const badgeCls = isMobile
    ? "absolute -top-1 -right-1 h-4 w-4 p-0 text-[10px]"
    : "absolute -top-1 -right-1 h-4 w-4 xl:h-5 xl:w-5 p-0 text-[10px] xl:text-xs";
  const gridCls = isMobile
    ? cn("grid gap-1.5", isTableSession ? "grid-cols-5" : "grid-cols-4")
    : cn("grid gap-1.5 xl:gap-2", isTableSession ? "grid-cols-5" : "grid-cols-4");
  const payBtnCls = isMobile
    ? "w-full h-12 text-lg"
    : "w-full h-12 xl:h-14 text-base xl:text-lg";
  const payIconCls = isMobile ? "h-5 w-5 mr-2" : "h-4 w-4 xl:h-5 xl:w-5 mr-2";
  const billLabel = isMobile ? "Print Bill" : "Bill";

  return (
    <>
      {/* Action Buttons */}
      <div className={gridCls}>
        <Button
          variant="outline"
          className={btnCls}
          onClick={wrap(callbacks.onClearCart)}
          disabled={cartEmpty}
        >
          <Trash2 className={iconCls} />
          <span className={labelCls}>Clear</span>
        </Button>
        {isTableSession ? (
          <>
            <Button
              variant="outline"
              className={btnCls}
              disabled={cartEmpty}
              onClick={wrap(callbacks.onSplitBill)}
            >
              <Split className={iconCls} />
              <span className={labelCls}>Split</span>
            </Button>
            <Button
              variant="outline"
              className={btnCls}
              onClick={wrap(callbacks.onTransferTable)}
            >
              <RotateCcw className={iconCls} />
              <span className={labelCls}>Transfer</span>
            </Button>
            <Button
              variant="outline"
              className={btnCls}
              disabled={cartEmpty}
              onClick={wrap(callbacks.onPrintBill)}
            >
              <Receipt className={iconCls} />
              <span className={labelCls}>{billLabel}</span>
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              className={btnRelCls}
              disabled={cartEmpty || !canHold}
              onClick={wrap(callbacks.onHold)}
            >
              <Pause className={iconCls} />
              <span className={labelCls}>Hold</span>
            </Button>
            <Button
              variant="outline"
              className={btnRelCls}
              onClick={wrap(callbacks.onRecallHeld)}
            >
              <Play className={iconCls} />
              <span className={labelCls}>Recall</span>
              {heldCount > 0 && (
                <Badge className={badgeCls}>
                  {heldCount}
                </Badge>
              )}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          className={btnCls}
          disabled={cartEmpty}
          onClick={wrap(callbacks.onDiscount)}
        >
          <Tag className={iconCls} />
          <span className={labelCls}>Discount</span>
        </Button>
      </div>

      {/* Quick Payment Buttons — desktop only. Mobile drawer uses
          the full-width Pay button below to keep the drawer compact. */}
      {!cartEmpty && !isMobile && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            className="h-10 xl:h-12 text-sm"
            onClick={wrap(callbacks.onOpenPayment)}
          >
            <Banknote className="h-4 w-4 xl:h-5 xl:w-5 mr-1 xl:mr-2" />
            Cash
          </Button>
          <Button
            variant="secondary"
            className="h-10 xl:h-12 text-sm"
            onClick={wrap(callbacks.onOpenPayment)}
          >
            <CreditCard className="h-4 w-4 xl:h-5 xl:w-5 mr-1 xl:mr-2" />
            Card
          </Button>
        </div>
      )}

      {/* Pay Button */}
      <Button
        className={payBtnCls}
        disabled={cartEmpty}
        onClick={wrap(callbacks.onOpenPayment)}
      >
        <CreditCard className={payIconCls} />
        Pay {formatCurrency(cart.total)}
      </Button>
    </>
  );
}