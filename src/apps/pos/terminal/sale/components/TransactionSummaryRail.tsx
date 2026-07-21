import { Sparkles } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { usePOSCartAdapter } from "@/hooks/pos/usePOSCartAdapter";

type Cart = ReturnType<typeof usePOSCartAdapter>;

export interface AppliedPromotionLine {
  promotion: { name: string };
  discountAmount: number;
}

export interface TransactionSummaryRailProps {
  cart: Pick<Cart, "subtotal" | "discount_amount" | "tax_amount" | "total">;
  appliedPromotions: AppliedPromotionLine[];
  formatCurrency: (value: number) => string;
  size?: "sm" | "md";
}

/**
 * TransactionSummaryRail — subtotal / discount / promos / tax / total
 * summary. Pure prop-driven. Extracted from POSTerminal.tsx (Step 6.2b).
 *
 * Designed for reuse: the same rail is mounted in the sale panel today
 * and will mount inside Tender + Receipt routes for permanent
 * business-state visibility (per parent prompt).
 */
export function TransactionSummaryRail({
  cart,
  appliedPromotions,
  formatCurrency,
  size = "md",
}: TransactionSummaryRailProps) {
  const totalClass =
    size === "sm"
      ? "flex justify-between text-base font-bold"
      : "flex justify-between text-base xl:text-lg font-bold";
  return (
    <div className="space-y-1.5 xl:space-y-2 text-sm">
      <div className="flex justify-between">
        <span className="text-muted-foreground">Subtotal</span>
        <span>{formatCurrency(cart.subtotal)}</span>
      </div>
      {cart.discount_amount > 0 && (
        <div className="flex justify-between text-green-600">
          <span>Discount</span>
          <span>-{formatCurrency(cart.discount_amount)}</span>
        </div>
      )}
      {appliedPromotions.length > 0 &&
        appliedPromotions.map((promo, i) => (
          <div key={i} className="flex justify-between text-xs text-green-600">
            <span className="flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              {promo.promotion.name}
            </span>
            <span>-{formatCurrency(promo.discountAmount)}</span>
          </div>
        ))}
      <div className="flex justify-between">
        <span className="text-muted-foreground">Tax</span>
        <span>{formatCurrency(cart.tax_amount)}</span>
      </div>
      <Separator />
      <div className={totalClass}>
        <span>Total</span>
        <span>{formatCurrency(cart.total)}</span>
      </div>
    </div>
  );
}