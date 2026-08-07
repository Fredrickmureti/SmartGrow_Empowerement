/**
 * PurchaseOrderReceiptsSection — the receipts a purchase order produced, and
 * the only operator entry point to reverse one (ADR 0128).
 *
 * `resolve_reversal_intent` has advertised a `goods_return` operation for goods
 * receipts since the intent engine shipped, but no surface could execute it:
 * the receipt document had no page, list or menu anywhere in the app, so
 * unwinding a mis-received truck meant a manual stock adjustment plus a manual
 * journal — two unlinked documents. This section closes that gap in the one
 * place a receipt is already meaningful to a buyer.
 */
import { useState } from "react";
import { format } from "date-fns";
import { Section, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { ReverseGoodsReceiptDialog } from "@/components/purchases/ReverseGoodsReceiptDialog";
import { useGoodsReceiptsForOrder, type OrderGoodsReceipt } from "./useGoodsReceiptsForOrder";

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

const TONE: Record<string, "neutral" | "success" | "danger" | "warning"> = {
  completed: "success",
  posted: "success",
  reversed: "danger",
  draft: "neutral",
  cancelled: "danger",
};

export function PurchaseOrderReceiptsSection({
  purchaseOrderId,
  currency,
}: {
  purchaseOrderId: string;
  currency?: string;
}) {
  const { receipts, loading, refetch } = useGoodsReceiptsForOrder(purchaseOrderId);
  const [reversing, setReversing] = useState<OrderGoodsReceipt | null>(null);

  if (loading && receipts.length === 0) return null;
  if (!loading && receipts.length === 0) return null;

  return (
    <Section title="Goods receipts">
      <div className="divide-y rounded-lg border">
        {receipts.map((receipt) => (
          <div
            key={receipt.id}
            className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{receipt.receipt_number}</span>
                <StatusBadge
                  status={receipt.status.replace(/_/g, " ")}
                  tone={TONE[receipt.status] ?? "neutral"}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Received {fmtDate(receipt.receipt_date)}
              </p>
            </div>
            {receipt.status !== "reversed" && (
              <Button variant="outline" size="sm" onClick={() => setReversing(receipt)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Reverse
              </Button>
            )}
          </div>
        ))}
      </div>

      <ReverseGoodsReceiptDialog
        receipt={reversing ? { ...reversing, currency } : null}
        open={Boolean(reversing)}
        onOpenChange={(open) => {
          if (!open) setReversing(null);
        }}
        onSuccess={() => {
          setReversing(null);
          void refetch();
        }}
      />
    </Section>
  );
}
