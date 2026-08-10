/**
 * BillRecordPage — object-page route for a Bill.
 *
 * Actions come from `useBillActions`, the same array the list row menu
 * (src/pages/Bills.tsx) renders, so the full page offers the exact same
 * action vocabulary. `EditBillDialog` remains the editor until the Bills
 * wizard slice lands.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useBillView } from "./billView";
import { useBillActions } from "./useBillActions";

export default function BillRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { bill, view, refresh } = useBillView(isNew ? null : id, formatCurrency);

  const { actions, dialogs } = useBillActions(bill, {
    onChanged: refresh,
    onDeleted: () => navigate("/purchases/bills"),
  });

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New bill"
        newDescription={
          <>
            The bill creation wizard is scheduled in the Purchases record
            migration. For now, use the <strong>New Bill</strong> action on
            the Bills list.
          </>
        }
        actions={actions}
      />
      {dialogs}
    </>
  );
}
