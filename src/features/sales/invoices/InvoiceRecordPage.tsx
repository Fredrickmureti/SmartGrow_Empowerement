/**
 * InvoiceRecordPage — the full-page projection of `useInvoiceView`.
 *
 * The page owns routing only; document content comes from the shared
 * descriptor and the action vocabulary comes from `useInvoiceActions`, so the
 * full page offers exactly what the list row menu offers.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useInvoiceView } from "./invoiceView";
import { useInvoiceActions } from "./useInvoiceActions";

export default function InvoiceRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { invoice, refresh, view } = useInvoiceView(
    isNew ? null : id,
    formatCurrency,
  );

  const { actions, dialogs } = useInvoiceActions(invoice, {
    onChanged: refresh,
    onDeleted: () => navigate("/sales/invoices"),
  });

  return (
    <>
      <RecordScaffold {...view} id={id} newLabel="New invoice" actions={actions} />
      {dialogs}
    </>
  );
}
