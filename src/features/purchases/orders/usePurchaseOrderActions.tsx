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
  Mail,
  Package,
  Pencil,
  Printer,
  Send,
  Trash2,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
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
  const { print, printing } = useRecordPrint("purchase_order");
  const { updatePurchaseOrder, deletePurchaseOrder, convertToBill } = usePurchaseOrders();
  const { send, dialog: emailDialog } = useDocumentEmail(onChanged);

  const actions = useMemo<DocumentAction[]>(() => {
    if (!po) return [];
    const status = po.status as string;
    const isDraft = status === "draft";
    const editable = ["draft", "sent"].includes(status);

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
        label: "Edit",
        icon: Pencil,
        group: "core",
        primary: true,
        disabled: !editable,
        disabledReason: editable
          ? undefined
          : "Only draft or sent purchase orders can be edited.",
        onSelect: () => navigate(`/purchases/orders/${po.id}/edit`),
      },
      {
        id: "mark-sent",
        label: "Mark as sent",
        icon: Send,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: run("Purchase order marked as sent", () =>
          updatePurchaseOrder(po.id, { status: "sent" }),
        ),
      },
      {
        id: "receive-goods",
        label: "Receive goods",
        icon: Package,
        group: "core",
        primary: ["sent", "partial_received"].includes(status),
        hidden: !["sent", "partial_received"].includes(status),
        onSelect: () =>
          navigate(
            `/warehouse-app/receiving?source_doc_type=purchase_order&source_doc_id=${po.id}`,
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
        hidden: !["draft", "sent"].includes(status),
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
        id: "print",
        label: printing ? "Generating…" : "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(po.id, `PO ${po.po_number}`),
      },
      {
        id: "cancel",
        label: "Cancel order",
        icon: Ban,
        destructive: true,
        hidden: status !== "sent",
        onSelect: run("Purchase order cancelled", () =>
          updatePurchaseOrder(po.id, { status: "cancelled" }),
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
  }, [po, printing, navigate, print, send]);

  return { actions, dialogs: <>{emailDialog}</> };
}
