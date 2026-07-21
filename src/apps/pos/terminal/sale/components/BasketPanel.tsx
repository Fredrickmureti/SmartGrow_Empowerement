import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { usePOSCartAdapter } from "@/hooks/pos/usePOSCartAdapter";
import type { usePOSSound } from "@/hooks/pos/usePOSSound";

type Cart = ReturnType<typeof usePOSCartAdapter>;
type Sound = ReturnType<typeof usePOSSound>;

export interface BasketPanelProps {
  cart: Cart;
  sound: Sound;
  formatCurrency: (value: number) => string;
}

/**
 * BasketPanel — sale-phase cart line list with qty controls.
 * Pure prop-driven. Extracted from POSTerminal.tsx (Step 6.2a).
 * Line-scoped modifier/discount dialogs remain owned by the parent.
 */
export function BasketPanel({ cart, sound, formatCurrency }: BasketPanelProps) {
  return (
    <ScrollArea className="flex-1">
      <div className="p-3 xl:p-4 space-y-2">
        {cart.items.length === 0 ? (
          <div className="text-center py-8 xl:py-12 text-muted-foreground">
            <div className="text-3xl xl:text-4xl mb-2">🛒</div>
            <p className="text-sm">Cart is empty</p>
            <p className="text-xs">Click products to add them</p>
          </div>
        ) : (
          cart.items.map((item) => (
            <div key={item.id} className="flex flex-col gap-2 p-2 xl:p-3 rounded-lg border">
              {/* Row 1: product name (full width, may wrap up to 2 lines) */}
              <p className="font-medium text-xs xl:text-sm leading-snug line-clamp-2 break-words">
                {item.name}
              </p>
              {/* Row 2: qty controls (left) · unit price + line total (right, never truncated) */}
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1 xl:gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7 xl:h-8 xl:w-8"
                    onClick={() => {
                      if (item.quantity - 1 <= 0) sound.play("cart_remove");
                      cart.updateQuantity(item.id, item.quantity - 1);
                    }}
                  >
                    <Minus className="h-3 w-3" />
                  </Button>
                  <span className="min-w-[1.5rem] xl:min-w-[2rem] text-center text-sm font-medium tabular-nums">
                    {item.quantity}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7 xl:h-8 xl:w-8"
                    onClick={() => cart.updateQuantity(item.id, item.quantity + 1)}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </div>
                <div className="flex flex-col items-end leading-tight ml-auto">
                  <p className="text-[11px] xl:text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                    {formatCurrency(item.unit_price)} × {item.quantity}
                  </p>
                  <p className="text-sm xl:text-base font-semibold tabular-nums whitespace-nowrap">
                    {formatCurrency(item.line_total)}
                  </p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
}