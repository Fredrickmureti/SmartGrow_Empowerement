/**
 * BillRecordPage — object-page route for a Bill.
 *
 * The page owns routing and actions only; every piece of document content
 * comes from the shared `useBillView` descriptor, which the peek sheet also
 * renders. Read-only in this pass; `EditBillDialog` remains the editor
 * until the Bills wizard slice lands.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Link2, Pencil, Printer } from "lucide-react";
import { toast } from "sonner";

import { ActionBar } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { useBillView } from "./billView";

export default function BillRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const [matching, setMatching] = useState(false);
  const isNew = id === "new";
  const { bill, view } = useBillView(isNew ? null : id, formatCurrency);

  const handleMatchReceipts = async () => {
    if (!bill?.id) return;
    setMatching(true);
    try {
      // ADR 0077 · 3-way match — RPC auto-links bill lines to open GRN
      // lines by (bill_id → PO → GRN → item) and records unit-cost
      // variances into bill_grn_matches. Idempotent on re-run.
      const { data, error: err } = await supabase.rpc("match_bill_to_grn", {
        p_bill_id: bill.id,
      });
      if (err) throw err;
      const count = typeof data === "number" ? data : 0;
      toast.success(
        count > 0
          ? `Matched ${count} bill line${count === 1 ? "" : "s"} to receipts`
          : "No new lines to match — bill is fully reconciled or has no PO link.",
      );
    } catch (err) {
      toast.error(`Match failed: ${(err as Error).message}`);
    } finally {
      setMatching(false);
    }
  };

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New bill"
      newDescription={
        <>
          The bill creation wizard is scheduled in the Purchases record
          migration. For now, use the <strong>New Bill</strong> action on the
          Bills list.
        </>
      }
      headerActions={
        bill ? (
          <ActionBar>
            <Button variant="outline" size="sm" onClick={() => navigate("/purchases/bills")}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleMatchReceipts}
              disabled={matching}
              title="Auto-link bill lines to open goods-receipt lines (3-way match)"
            >
              <Link2 className="mr-2 h-4 w-4" />
              {matching ? "Matching…" : "Match receipts"}
            </Button>
            <Button variant="outline" size="sm" disabled>
              <Printer className="mr-2 h-4 w-4" /> Print
            </Button>
            <Button
              size="sm"
              disabled
              title="Editing still uses the list dialog while migration is in progress"
            >
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </Button>
          </ActionBar>
        ) : undefined
      }
    />
  );
}
