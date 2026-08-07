/**
 * InvoiceRecordPage — the full-page projection of `useInvoiceView`.
 *
 * The page owns routing and actions only; every piece of document content
 * comes from the shared descriptor, which the peek sheet also renders.
 */
import { useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { useCurrency } from "@/hooks/useCurrency";
import { useInvoiceView } from "./invoiceView";

export default function InvoiceRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency } = useCurrency();
  const { print, printing } = useRecordPrint("invoice");
  const { preview } = useDocumentPreview();
  const isNew = id === "new";
  const { invoice, view } = useInvoiceView(isNew ? null : id, formatCurrency);

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New invoice"
      onPreview={
        invoice
          ? () =>
              preview({
                documentType: "invoice",
                documentId: invoice.id,
                title: `Invoice ${invoice.invoice_number}`,
                filename: `invoice-${invoice.invoice_number}`,
              })
          : undefined
      }
      onPrint={
        invoice && !printing
          ? () => void print(invoice.id, `Invoice ${invoice.invoice_number}`)
          : undefined
      }
    />
  );
}
