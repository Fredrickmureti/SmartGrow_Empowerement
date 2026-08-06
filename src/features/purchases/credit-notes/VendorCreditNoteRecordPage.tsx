/**
 * VendorCreditNoteRecordPage — the full-page projection of
 * `useVendorCreditNoteView`. Owns routing and actions only; content comes
 * from the shared descriptor, which the peek sheet also renders.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useVendorCreditNoteView } from "./vendorCreditNoteView";

export default function VendorCreditNoteRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { creditNote, view } = useVendorCreditNoteView(isNew ? null : id, formatCurrency);

  const isDraft = creditNote?.status === "draft";

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New credit note"
      onEdit={
        creditNote && isDraft
          ? () => navigate(`/purchases/credit-notes/${creditNote.id}/edit`)
          : undefined
      }
    />
  );
}
