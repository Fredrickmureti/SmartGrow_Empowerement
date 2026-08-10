/**
 * useEstimateActions — the single declaration of what you can do to a Sales
 * Estimate, rendered identically by the list row menu and the record page.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRightLeft,
  CheckCircle2,
  Edit,
  FileSearch,
  Mail,
  Printer,
  Send,
  ShoppingCart,
  Trash2,
  X,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { useDocumentEmail } from "@/features/sales/record/useDocumentEmail";
import { useEstimates, type Estimate } from "@/hooks/useEstimates";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function useEstimateActions(
  estimate: Estimate | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("estimate");
  const { setEstimateStatus, deleteEstimate, convertToInvoice, convertToSalesOrder } =
    useEstimates();
  const { send, dialog } = useDocumentEmail(onChanged);

  const actions = useMemo<DocumentAction[]>(() => {
    if (!estimate) return [];
    const status = estimate.status as string;
    const isDraft = status === "draft";
    const isOpen = ["sent", "viewed"].includes(status);
    const convertible =
      status === "accepted" &&
      !estimate.converted_invoice_id &&
      !estimate.converted_sales_order_id;

    const run = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        toast({ title: label });
        onChanged?.();
      } catch (error: unknown) {
        toast({
          title: "Action failed",
          description: normalizeError(error).message,
          variant: "destructive",
        });
      }
    };

    return [
      {
        id: "edit",
        label: "Edit",
        icon: Edit,
        group: "core",
        primary: true,
        hidden: !isDraft,
        onSelect: () => navigate(`/sales/estimates/${estimate.id}/edit`),
      },
      {
        id: "mark-sent",
        label: "Mark as sent",
        icon: Send,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: () =>
          void run("Status updated", () =>
            setEstimateStatus(estimate.id, "sent" as Estimate["status"]),
          ),
      },
      {
        id: "mark-accepted",
        label: "Mark accepted",
        icon: CheckCircle2,
        group: "core",
        primary: isOpen,
        hidden: !isOpen,
        onSelect: () =>
          void run("Status updated", () =>
            setEstimateStatus(estimate.id, "accepted" as Estimate["status"]),
          ),
      },
      {
        id: "mark-rejected",
        label: "Mark rejected",
        icon: X,
        group: "core",
        hidden: !isOpen,
        onSelect: () =>
          void run("Status updated", () =>
            setEstimateStatus(estimate.id, "rejected" as Estimate["status"]),
          ),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "estimate",
            documentId: estimate.id,
            title: `Estimate ${estimate.estimate_number}`,
            filename: `estimate-${estimate.estimate_number}`,
          }),
      },
      {
        id: "print",
        label: "Print / download",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () =>
          void print(estimate.id, `Estimate ${estimate.estimate_number}`),
      },
      {
        id: "email",
        label: "Send via email",
        icon: Mail,
        group: "output",
        onSelect: () =>
          send({
            documentType: "estimate",
            documentId: estimate.id,
            documentNumber: estimate.estimate_number,
            recipientEmail: estimate.contact?.email || "",
            recipientName: estimate.contact?.name || "",
            total: estimate.total,
            currency: estimate.currency || undefined,
          } as never),
      },
      {
        id: "convert-so",
        label: "Convert to sales order",
        icon: ShoppingCart,
        group: "convert",
        primary: convertible,
        hidden: !convertible,
        onSelect: () =>
          void run("Converted to sales order", () =>
            convertToSalesOrder(estimate.id),
          ),
      },
      {
        id: "convert-invoice",
        label: "Convert to invoice",
        icon: ArrowRightLeft,
        group: "convert",
        hidden: !convertible,
        onSelect: () =>
          void run("Converted to invoice", () => convertToInvoice(estimate.id)),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        onSelect: () =>
          void (async () => {
            try {
              await deleteEstimate(estimate.id);
              toast({ title: "Estimate deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting estimate",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimate, printing, navigate, preview, print, send]);

  return { actions, dialogs: dialog };
}
