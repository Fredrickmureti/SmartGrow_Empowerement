/**
 * InvoicePeekSheet — the drawer projection of `useInvoiceView`.
 *
 * Same descriptor as the full page. The peek stays read-oriented: all
 * record-affecting actions remain with the list's row action menu.
 */
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useInvoiceView } from "./invoiceView";

interface InvoicePeekSheetProps {
  invoiceId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function InvoicePeekSheet({ invoiceId, onOpenChange }: InvoicePeekSheetProps) {
  const { formatCurrency } = useCurrency();
  const { invoice, view } = useInvoiceView(invoiceId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!invoiceId}
      onOpenChange={onOpenChange}
      fullPageHref={invoice ? `/sales/invoices/${invoice.id}` : undefined}
    />
  );
}

export default InvoicePeekSheet;
