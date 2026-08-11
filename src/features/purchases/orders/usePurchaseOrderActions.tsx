/**
 * usePurchaseOrderActions — the single declaration of what you can do to a
 * Purchase Order. The record page header renders this array, and any row
 * menu that adopts it renders the same one, so the full page can never be
 * a dead end again.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRightLeft,
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSearch,
  Lock,
  Mail,
  Package,
  Pencil,
  Printer,
  RotateCcw,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
import { useRecordDownload } from "@/features/purchases/record/useRecordDownload";
import { useDocumentEmail } from "@/features/purchases/record/useDocumentEmail";
import { usePurchaseOrders, type PurchaseOrder } from "@/hooks/usePurchaseOrders";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function usePurchaseOrderActions(
  po: (PurchaseOrder & { vendor?: { name: string; email?: string | null } | null }) | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("purchase_order");
  const { download, downloading } = useRecordDownload("purchase_order");
  const {
    deletePurchaseOrder,
    convertToBill,
    submitPurchaseOrder,
    approvePurchaseOrder,
    rejectPurchaseOrder,
    releasePurchaseOrder,
    cancelPurchaseOrder,
    revisePurchaseOrder,
    closePurchaseOrder,
  } = usePurchaseOrders();
  const { send, dialog: emailDialog } = useDocumentEmail(onChanged);

  const actions = useMemo<DocumentAction[]>(() => {
    if (!po) return [];
    const status = po.status as string;
    const isDraft = status === "draft";
    // Once a PO is submitted the line data is frozen: changing it means
    // creating a revision, which the state machine handles explicitly.
    const editable = ["draft", "revised", "rejected"].includes(status);
    const canSubmit = ["draft", "revised"].includes(status);
    const canDecide = status === "submitted";
    const canRelease = status === "approved";
    const canRevise = ["submitted", "approved", "acknowledged", "sent"].includes(status);
    const canReceive = ["sent", "acknowledged", "partial_received"].includes(status);
    const canClose = ["partial_received", "received"].includes(status);
    const canCancel = !["cancelled", "closed", "received", "draft"].includes(status);

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

    /** Reason-carrying transitions must record *why*, not just *what*. */
    const withReason = (
      promptText: string,
      label: string,
      fn: (reason: string) => Promise<unknown>,
      required = true,
    ) => () => {
      const reason = window.prompt(promptText) ?? "";
      if (required && !reason.trim()) return;
      run(label, () => fn(reason.trim()))();
    };

    return [
      {
        id: "edit",
        label: "Edit",
        icon: Pencil,
        group: "core",
        primary: isDraft,
        disabled: !editable,
        disabledReason: editable
          ? undefined
          : "This order is past draft — create a revision to change it.",
        onSelect: () => navigate(`/purchases/orders/${po.id}/edit`),
      },
      {
        id: "submit",
        label: "Submit for approval",
        icon: Send,
        group: "core",
        primary: canSubmit,
        hidden: !canSubmit,
        onSelect: run("Submitted for approval", () => submitPurchaseOrder(po.id)),
      },
      {
        id: "approve",
        label: "Approve",
        icon: CheckCircle2,
        group: "core",
        primary: canDecide,
        hidden: !canDecide,
        onSelect: run("Purchase order approved", () => approvePurchaseOrder(po.id)),
      },
      {
        id: "reject",
        label: "Reject",
        icon: XCircle,
        group: "core",
        destructive: true,
        hidden: !canDecide,
        onSelect: withReason("Reason for rejection:", "Purchase order rejected", (reason) =>
          rejectPurchaseOrder(po.id, reason),
        ),
      },
      {
        id: "release",
        label: "Release to supplier",
        icon: Send,
        group: "core",
        primary: canRelease,
        hidden: !canRelease,
        onSelect: run("Purchase order released to supplier", () => releasePurchaseOrder(po.id)),
      },
      {
        id: "revise",
        label: "Create revision",
        icon: RotateCcw,
        group: "core",
        hidden: !canRevise,
        onSelect: withReason("Reason for the revision:", "Revision created", (reason) =>
          revisePurchaseOrder(po.id, reason),
        ),
      },
      {
        id: "receive-goods",
        label: "Receive goods",
        icon: Package,
        group: "core",
        primary: canReceive,
        hidden: !canReceive,
        onSelect: () =>
          navigate(
            `/warehouse-app/receiving?source_doc_type=purchase_order&source_doc_id=${po.id}`,
          ),
      },
      {
        id: "close",
        label: "Close order",
        icon: Lock,
        group: "core",
        hidden: !canClose,
        onSelect: withReason(
          "Reason for closing (optional):",
          "Purchase order closed",
          (reason) => closePurchaseOrder(po.id, reason),
          false,
        ),
      },
      {
        id: "convert-to-bill",
        label: "Convert to bill",
        icon: ArrowRightLeft,
        group: "core",
        primary: status === "received" && !po.converted_bill_id,
        hidden: status !== "received" || !!po.converted_bill_id,
        onSelect: run("Bill created from purchase order", () => convertToBill(po.id)),
      },
      {
        id: "email",
        label: "Send to supplier",
        icon: Mail,
        group: "output",
        hidden: !["draft", "approved", "sent", "acknowledged"].includes(status),
        onSelect: () =>
          send({
            documentType: "purchase_order",
            documentId: po.id,
            documentNumber: po.po_number,
            recipientEmail: po.vendor?.email ?? "",
            recipientName: po.vendor?.name ?? "",
            total: po.total,
            currency: po.currency,
          }),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "purchase_order",
            documentId: po.id,
            title: `Purchase Order ${po.po_number}`,
            filename: `purchase-order-${po.po_number}`,
          }),
      },
      {
        id: "print",
        label: printing ? "Generating…" : "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(po.id, `PO ${po.po_number}`),
      },
      {
        id: "download",
        label: downloading ? "Preparing…" : "Download PDF",
        icon: Download,
        group: "output",
        disabled: downloading,
        onSelect: () => void download(po.id, `purchase-order-${po.po_number}`),
      },
      {
        id: "cancel",
        label: "Cancel order",
        icon: Ban,
        destructive: true,
        hidden: !canCancel,
        onSelect: withReason("Reason for cancelling:", "Purchase order cancelled", (reason) =>
          cancelPurchaseOrder(po.id, reason),
        ),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        onSelect: () => {
          if (!window.confirm(`Delete purchase order ${po.po_number}?`)) return;
          void (async () => {
            try {
              await deletePurchaseOrder(po.id);
              toast({ title: "Purchase order deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting purchase order",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })();
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po, printing, downloading, navigate, preview, print, download, send]);

  return { actions, dialogs: <>{emailDialog}</> };
}
