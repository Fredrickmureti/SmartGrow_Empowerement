/**
 * VendorCreditNoteRecordPage — the full-page projection of
 * `useVendorCreditNoteView`. Actions come from
 * `useVendorCreditNoteActions`, the same vocabulary the list row menu
 * offers.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useVendorCreditNoteView } from "./vendorCreditNoteView";
import { useVendorCreditNoteActions } from "./useVendorCreditNoteActions";

export default function VendorCreditNoteRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { creditNote, view, refresh } = useVendorCreditNoteView(
    isNew ? null : id,
    formatCurrency,
  );

  const actions = useVendorCreditNoteActions(creditNote, {
    onChanged: refresh,
    onDeleted: () => navigate("/purchases/credit-notes"),
  });

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New credit note"
      actions={actions}
    />
  );
}
