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
import { RotateCcw, Undo2 } from "lucide-react";
import { GoodsReceiptReturnLedger } from "./GoodsReceiptReturnLedger";
import { ReverseGoodsReceiptDialog } from "@/components/purchases/ReverseGoodsReceiptDialog";
import { useGoodsReceiptsForOrder, type OrderGoodsReceipt } from "./useGoodsReceiptsForOrder";
import { LandedCostReceiptChip } from "@/features/purchases/landed-costs/LandedCostReceiptChip";
import { useLandedCostReceiptSummary } from "@/features/purchases/landed-costs/useLandedCostReporting";
import { useCurrency } from "@/hooks/useCurrency";

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
  const { formatCurrency } = useCurrency();
  const { byReceipt: landedCostByReceipt } = useLandedCostReceiptSummary(
    receipts.map((r) => r.id),
  );
  const [reversing, setReversing] = useState<OrderGoodsReceipt | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading && receipts.length === 0) return null;
  if (!loading && receipts.length === 0) return null;

  return (
    <div id="receipts">
    <Section title="Goods receipts">
      <div className="divide-y rounded-lg border">
        {receipts.map((receipt) => (
          <div key={receipt.id} className="text-sm">
          <div
            className="flex flex-wrap items-center justify-between gap-3 p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{receipt.receipt_number}</span>
                <StatusBadge tone={TONE[receipt.status] ?? "neutral"}>
                  {receipt.status.replace(/_/g, " ")}
                </StatusBadge>

              </div>
              <p className="text-xs text-muted-foreground">
                Received {fmtDate(receipt.receipt_date)}
              </p>
              <LandedCostReceiptChip
                summary={landedCostByReceipt.get(receipt.id)}
                formatCurrency={formatCurrency}
              />
            </div>
            <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(expanded === receipt.id ? null : receipt.id)}
            >
              <Undo2 className="mr-2 h-4 w-4" />
              {expanded === receipt.id ? "Hide returns" : "Returned"}
            </Button>
            {receipt.status !== "reversed" && (
              <Button variant="outline" size="sm" onClick={() => setReversing(receipt)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Reverse
              </Button>
            )}
            </div>
          </div>
          {expanded === receipt.id && <GoodsReceiptReturnLedger receiptId={receipt.id} />}
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
    </div>
  );
}
