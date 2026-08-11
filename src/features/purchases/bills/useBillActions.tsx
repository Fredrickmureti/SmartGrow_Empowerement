/**
 * useBillActions — the single declaration of what you can do to a Bill,
 * rendered identically by the list row menu (src/pages/Bills.tsx) and the
 * record page.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  BookCheck,
  CheckCircle,
  CreditCard,
  Download,
  Edit,
  FileSearch,
  History,
  Link2,
  Mail,
  Printer,
  RotateCcw,
  Send,
  ThumbsUp,
  Trash2,
  Undo2,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
import { useRecordDownload } from "@/features/purchases/record/useRecordDownload";
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
  const { download, downloading } = useRecordDownload("bill");
  const {
    confirmBill,
    deleteBill,
    requireBillApproval,
    submitBillForApproval,
    approveBill,
    rejectBill,
  } = useBills();
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
      // ADR 0123-family · single matcher. `match_bill_atomic` is the only
      // engine allowed to write `bill_match_results` / `bill_grn_matches`.
      // It runs automatically on submit; this action is a manual re-run.
      const { data: userRes } = await supabase.auth.getUser();
      const actor = userRes.user?.id;
      if (!actor) throw new Error("You must be signed in to match a bill.");
      const { data, error: err } = await supabase.rpc("match_bill_atomic", {
        _bill_id: bill.id,
        _actor: actor,
      });
      if (err) throw err;
      const result = (data ?? {}) as { match_state?: string; grn_links?: number };
      const state = result.match_state ?? "matched";
      toast({
        title: state === "matched" ? "Bill matched to receipts" : `Match exception: ${state.replace(/_/g, " ")}`,
        description:
          state === "matched"
            ? `${result.grn_links ?? 0} receipt line link${result.grn_links === 1 ? "" : "s"} recorded.`
            : "Approval is blocked until the exception is reviewed.",
        variant: state === "matched" ? undefined : "destructive",
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
