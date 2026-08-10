/**
 * useSalesOrderActions — the single declaration of what you can do to a Sales
 * Order, rendered identically by the list row menu and the record page.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Ban,
  CheckCircle,
  Edit,
  FileSearch,
  Mail,
  Printer,
  Trash2,
  Truck,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { useDocumentEmail } from "@/features/sales/record/useDocumentEmail";
import { useSalesOrders, type SalesOrder } from "@/hooks/useSalesOrders";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function useSalesOrderActions(
  order: SalesOrder | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("sales_order");
  const {
    confirmSalesOrder,
    cancelSalesOrder,
    createDeliveryNote,
    convertToInvoice,
    deleteSalesOrder,
  } = useSalesOrders();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { send, dialog } = useDocumentEmail(onChanged);

  const actions = useMemo<DocumentAction[]>(() => {
    if (!order) return [];
    const status = order.status as string;
    const isDraft = status === "draft";
    const deliverable = ["confirmed", "processing", "partial"].includes(status);
    const invoiceable =
      !order.converted_invoice_id &&
      ["confirmed", "processing", "partial", "fulfilled"].includes(status);
    const cancellable = ["draft", "confirmed"].includes(status);

    const guard = (fn: () => void) => () => {
      if (isReadOnly) {
        openUpgradeModal("sales_orders");
        return;
      }
      fn();
    };

    const run = (label: string, fn: () => Promise<unknown>) =>
      guard(() => {
        void (async () => {
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
        })();
      });

    return [
      {
        id: "edit",
        label: "Edit order",
        icon: Edit,
        group: "core",
        primary: true,
        hidden: !isDraft,
        onSelect: guard(() => navigate(`/sales/orders/${order.id}/edit`)),
      },
      {
        id: "confirm",
        label: "Confirm order",
        icon: CheckCircle,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: run("Order confirmed", () => confirmSalesOrder(order.id)),
      },
      {
        id: "delivery-note",
        label: "Create delivery note",
        icon: Truck,
        group: "fulfil",
        primary: deliverable,
        hidden: !deliverable,
        onSelect: run("Delivery note created", () =>
          createDeliveryNote(order.id),
        ),
      },
      {
        id: "convert-invoice",
        label: "Convert to invoice",
        icon: ArrowRight,
        group: "fulfil",
        primary: invoiceable && !deliverable,
        hidden: !invoiceable,
        onSelect: run("Invoice created", () => convertToInvoice(order.id)),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "sales_order",
            documentId: order.id,
            title: `Sales Order ${order.so_number}`,
            filename: `sales-order-${order.so_number}`,
          }),
      },
      {
        id: "print",
        label: "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(order.id, `Sales Order ${order.so_number}`),
      },
      {
        id: "email",
        label: "Send via email",
        icon: Mail,
        group: "output",
        onSelect: () =>
          send({
            documentType: "sales_order",
            documentId: order.id,
            documentNumber: order.so_number,
            recipientEmail: order.contact?.email || "",
            recipientName: order.contact?.name || "",
            total: order.total,
            currency: order.currency || undefined,
          } as never),
      },
      {
        id: "cancel",
        label: "Cancel",
        icon: Ban,
        destructive: true,
        hidden: !cancellable,
        onSelect: run("Order cancelled", () => cancelSalesOrder(order.id)),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        onSelect: guard(() => {
          void (async () => {
            try {
              await deleteSalesOrder(order.id);
              toast({ title: "Sales order deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting order",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })();
        }),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, printing, isReadOnly, navigate, preview, print, send]);

  return { actions, dialogs: dialog };
}
