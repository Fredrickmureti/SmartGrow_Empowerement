/**
 * useBillActions — the single declaration of what you can do to a Bill,
 * rendered identically by the list row menu (src/pages/Bills.tsx) and the
 * record page.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  CheckCircle,
  CreditCard,
  Edit,
  FileSearch,
  History,
  Link2,
  Mail,
  Printer,
  RotateCcw,
  Trash2,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
import { useDocumentEmail } from "@/features/purchases/record/useDocumentEmail";
import { supabase } from "@/integrations/supabase/client";
import { useBills, type Bill } from "@/hooks/useBills";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { RecordBillPaymentDialog } from "@/components/bills/RecordBillPaymentDialog";
import { BillPaymentHistoryDialog } from "@/components/bills/BillPaymentHistoryDialog";
import { VoidBillDialog } from "@/components/bills/VoidBillDialog";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function useBillActions(
  bill: Bill | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("bill");
  const { confirmBill, deleteBill } = useBills();
  const { canManagePurchases } = usePermissions();
  const { send, dialog: emailDialog } = useDocumentEmail(onChanged);

  const [matching, setMatching] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState(false);

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
      toast({
        title: count > 0 ? `Matched ${count} bill line${count === 1 ? "" : "s"} to receipts` : "No new lines to match",
        description: count > 0 ? undefined : "Bill is fully reconciled or has no PO link.",
      });
      onChanged?.();
    } catch (err) {
      toast({ title: "Match failed", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setMatching(false);
    }
  };

  const actions = useMemo<DocumentAction[]>(() => {
    if (!bill) return [];
    const status = bill.status as string;
    const isDraft = status === "draft";
    const editable = status !== "paid" && status !== "void";
    const payable = status !== "paid" && status !== "void";
    const hasPayments = (bill.amount_paid ?? 0) > 0;
    const voidable = status === "received" || status === "partial";
    const returnable = status === "received" || status === "partial";

    const run = (label: string | null, fn: () => Promise<unknown>) => () => {
      void (async () => {
        try {
          await fn();
          if (label) toast({ title: label });
          onChanged?.();
        } catch (error: unknown) {
          toast({
            title: "Action failed",
            description: normalizeError(error).message,
            variant: "destructive",
          });
        }
      })();
    };

    return [
      {
        id: "edit",
        label: "Edit bill",
        icon: Edit,
        group: "core",
        primary: isDraft,
        hidden: !editable,
        onSelect: () => navigate(`/purchases/bills/${bill.id}/edit`),
      },
      {
        id: "confirm",
        label: "Confirm bill",
        icon: CheckCircle,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        // confirmBill toasts on success internally.
        onSelect: run(null, () => confirmBill(bill.id)),
      },
      {
        id: "match-receipts",
        label: matching ? "Matching…" : "Match receipts",
        icon: Link2,
        group: "core",
        disabled: matching,
        disabledReason: "Auto-link bill lines to open goods-receipt lines (3-way match)",
        onSelect: () => void handleMatchReceipts(),
      },
      {
        id: "record-payment",
        label: "Record payment",
        icon: CreditCard,
        group: "money",
        primary: payable && !isDraft,
        hidden: !payable,
        onSelect: () => setShowPaymentDialog(true),
      },
      {
        id: "payment-history",
        label: "Payment history",
        icon: History,
        group: "money",
        hidden: !hasPayments,
        onSelect: () => setShowHistoryDialog(true),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "bill",
            documentId: bill.id,
            title: `Bill ${bill.bill_number}`,
            filename: `bill-${bill.bill_number}`,
          }),
      },
      {
        id: "print",
        label: "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(bill.id, `Bill ${bill.bill_number}`),
      },
      {
        id: "email",
        label: "Email vendor",
        icon: Mail,
        group: "output",
        hidden: !bill.vendor_id,
        onSelect: () =>
          send({
            documentType: "bill",
            documentId: bill.id,
            documentNumber: bill.bill_number,
            recipientEmail: bill.vendor?.email || "",
            recipientName: bill.vendor?.name || "",
            total: bill.total,
            currency: bill.currency,
          } as never),
      },
      {
        id: "purchase-return",
        label: "Create purchase return",
        icon: RotateCcw,
        group: "fulfil",
        hidden: !returnable,
        onSelect: () =>
          navigate(`/purchases/returns?action=create&contact_id=${bill.vendor_id || ""}`),
      },
      {
        id: "void",
        label: "Void bill",
        icon: Ban,
        destructive: true,
        hidden: !voidable,
        onSelect: () => setShowVoidDialog(true),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft || !canManagePurchases,
        onSelect: () => {
          void (async () => {
            try {
              await deleteBill(bill.id);
              toast({ title: "Bill deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting bill",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })();
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill, matching, printing, canManagePurchases, navigate, preview, print, send]);

  const dialogs = (
    <>
      {emailDialog}
      <RecordBillPaymentDialog
        bill={bill ?? null}
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        onSuccess={() => onChanged?.()}
      />
      <BillPaymentHistoryDialog
        bill={bill ?? null}
        open={showHistoryDialog}
        onOpenChange={setShowHistoryDialog}
      />
      <VoidBillDialog
        bill={bill ?? null}
        open={showVoidDialog}
        onOpenChange={setShowVoidDialog}
        onSuccess={() => onChanged?.()}
      />
    </>
  );

  return { actions, dialogs };
}
