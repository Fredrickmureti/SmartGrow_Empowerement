/**
 * useInvoiceActions — the single declaration of what you can *do* to a Sales
 * Invoice.
 *
 * Before this hook the action vocabulary lived inside the list page's local
 * state, so the full-page record view offered a permanently-disabled Edit
 * button and nothing else. Actions now belong to the document, not to the
 * screen that happens to show it: the hook owns its own dialogs and returns a
 * `DocumentAction[]` any surface can render.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  CheckCircle2,
  CreditCard,
  Edit,
  FileSearch,
  History,
  Mail,
  Printer,
  Receipt,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import {
  ConfirmDeleteDialog,
  useConfirmDelete,
} from "@/components/shared/ConfirmDeleteDialog";
import { RecordCustomerPaymentDialog } from "@/components/payments/RecordCustomerPaymentDialog";
import { PaymentHistoryDialog } from "@/components/invoices/PaymentHistoryDialog";
import { VoidInvoiceDialog } from "@/components/invoices/VoidInvoiceDialog";
import {
  SendDocumentDialog,
  type DocumentEmailData,
} from "@/components/common/SendDocumentDialog";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { useInvoicesPaginated, type Invoice } from "@/hooks/useInvoicesPaginated";
import { isInvoicePayable } from "@/services/finance/invoicePayability";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  /** Re-fetch the record after a mutation succeeds. */
  onChanged?: () => void;
  /** Where to go after the record stops existing (delete). */
  onDeleted?: () => void;
}

export function useInvoiceActions(
  invoice: Invoice | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("invoice");
  const { updateInvoiceStatus, deleteInvoice } = useInvoicesPaginated();

  const [showPayment, setShowPayment] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(
    null,
  );
  const [showEmail, setShowEmail] = useState(false);

  const deleteConfirm = useConfirmDelete<Invoice>({
    onConfirm: async (inv) => {
      try {
        await deleteInvoice(inv.id);
        toast({ title: "Invoice deleted" });
        onDeleted?.();
      } catch (error: unknown) {
        toast({
          title: "Error deleting invoice",
          description: normalizeError(error).message,
          variant: "destructive",
        });
      }
    },
  });

  const actions = useMemo<DocumentAction[]>(() => {
    if (!invoice) return [];
    const status = invoice.status as string;
    const isDraft = status === "draft";
    const isClosed = isDraft || status === "cancelled" || status === "voided";

    const changeStatus = async (next: Invoice["status"]) => {
      try {
        await updateInvoiceStatus(invoice.id, next);
        toast({ title: `Invoice marked as ${next}` });
        onChanged?.();
      } catch (error: unknown) {
        toast({
          title: "Error updating invoice",
          description: normalizeError(error).message,
          variant: "destructive",
        });
      }
    };

    return [
      {
        id: "edit",
        label: "Edit invoice",
        icon: Edit,
        group: "core",
        primary: true,
        hidden: !isDraft,
        onSelect: () => navigate(`/sales/invoices/${invoice.id}/edit`),
      },
      {
        id: "confirm",
        label: "Confirm & release stock",
        icon: CheckCircle2,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: () => void changeStatus("confirmed" as Invoice["status"]),
      },
      {
        id: "confirm-send",
        label: "Confirm, release stock & send",
        icon: Send,
        group: "core",
        hidden: !isDraft,
        onSelect: () => void changeStatus("sent"),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "invoice",
            documentId: invoice.id,
            title: `Invoice ${invoice.invoice_number}`,
            filename: `invoice-${invoice.invoice_number}`,
          }),
      },
      {
        id: "print",
        label: "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () =>
          void print(invoice.id, `Invoice ${invoice.invoice_number}`),
      },
      {
        id: "email",
        label: "Send via email",
        icon: Mail,
        group: "output",
        onSelect: () => {
          setEmailDocument({
            documentType: "invoice",
            documentId: invoice.id,
            documentNumber: invoice.invoice_number,
            recipientEmail: invoice.contact?.email || "",
            recipientName: invoice.contact?.name || "",
            total: invoice.total,
            currency: invoice.currency || undefined,
          } as DocumentEmailData);
          setShowEmail(true);
        },
      },
      {
        id: "record-payment",
        label: "Record payment",
        icon: CreditCard,
        group: "money",
        primary: !isDraft && isInvoicePayable(invoice),
        hidden: !isInvoicePayable(invoice),
        onSelect: () => setShowPayment(true),
      },
      {
        id: "payment-history",
        label: "Payment history",
        icon: History,
        group: "money",
        hidden: !(invoice.amount_paid > 0),
        onSelect: () => setShowHistory(true),
      },
      {
        id: "receipt",
        label: "View receipt",
        icon: Receipt,
        group: "money",
        hidden: status !== "paid",
        onSelect: () =>
          preview({
            documentType: "receipt",
            documentId: invoice.id,
            title: `Receipt — ${invoice.invoice_number}`,
            filename: `receipt-${invoice.invoice_number}`,
          }),
      },
      {
        id: "credit-note",
        label: "Create credit note",
        icon: CreditCard,
        group: "compensation",
        hidden: isClosed,
        onSelect: () =>
          navigate(
            `/sales/credit-notes?action=create&contact_id=${invoice.contact_id}&invoice_id=${invoice.id}`,
          ),
      },
      {
        id: "return",
        label: "Create sales return",
        icon: RotateCcw,
        group: "compensation",
        hidden: isClosed,
        onSelect: () =>
          navigate(
            `/sales/returns?action=create&contact_id=${invoice.contact_id}&invoice_id=${invoice.id}`,
          ),
      },
      {
        id: "void",
        label: "Void invoice",
        icon: Ban,
        destructive: true,
        hidden: isClosed,
        onSelect: () => setShowVoid(true),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        onSelect: () => deleteConfirm.requestDelete(invoice),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice, printing, navigate, preview, print]);

  const dialogs = (
    <>
      <RecordCustomerPaymentDialog
        invoice={invoice ?? null}
        open={showPayment}
        onOpenChange={setShowPayment}
        onSuccess={() => onChanged?.()}
      />
      <PaymentHistoryDialog
        invoice={invoice ?? null}
        open={showHistory}
        onOpenChange={setShowHistory}
      />
      <VoidInvoiceDialog
        invoice={invoice ?? null}
        open={showVoid}
        onOpenChange={setShowVoid}
        onReversePayment={() => {
          setShowVoid(false);
          setShowHistory(true);
        }}
        onSuccess={() => {
          setShowVoid(false);
          onChanged?.();
        }}
      />
      <SendDocumentDialog
        open={showEmail}
        onOpenChange={setShowEmail}
        document={emailDocument}
        onSuccess={() => onChanged?.()}
      />
      <ConfirmDeleteDialog
        open={deleteConfirm.isOpen}
        onOpenChange={deleteConfirm.setIsOpen}
        title="Delete Invoice"
        itemName={deleteConfirm.itemToDelete?.invoice_number}
        onConfirm={deleteConfirm.confirmDelete}
        isLoading={deleteConfirm.isDeleting}
      />
    </>
  );

  return { actions, dialogs };
}
