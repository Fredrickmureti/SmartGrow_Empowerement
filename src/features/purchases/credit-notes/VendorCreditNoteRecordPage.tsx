/**
 * VendorCreditNoteRecordPage — the full-page projection of
 * `useVendorCreditNoteView`. Actions come from
 * `useVendorCreditNoteActions`, the same vocabulary the list row menu
 * offers.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { ReverseVendorCreditNoteDialog } from "@/components/purchases/ReverseVendorCreditNoteDialog";
import { useVendorCreditNoteView } from "./vendorCreditNoteView";
import { useVendorCreditNoteActions } from "./useVendorCreditNoteActions";

export default function VendorCreditNoteRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const [reverseOpen, setReverseOpen] = useState(false);
  const { creditNote, view, refresh } = useVendorCreditNoteView(
    isNew ? null : id,
    formatCurrency,
  );

  const { actions, dialog: actionDialogs } = useVendorCreditNoteActions(creditNote, {
    onChanged: refresh,
    onDeleted: () => navigate("/purchases/credit-notes"),
    onReverse: () => setReverseOpen(true),
  });

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New credit note"
        actions={actions}
      />
      <ReverseVendorCreditNoteDialog
        creditNote={
          creditNote
            ? {
                id: creditNote.id,
                credit_note_number: creditNote.credit_note_number,
                currency: creditNote.currency,
              }
            : null
        }
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        onSuccess={refresh}
      />
      {actionDialogs}
    </>
  );
}
