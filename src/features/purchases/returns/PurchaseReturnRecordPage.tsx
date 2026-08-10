/**
 * PurchaseReturnRecordPage — the full-page projection of
 * `usePurchaseReturnView`. Actions come from `usePurchaseReturnActions`,
 * the same vocabulary the list row menu offers.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseReturnView } from "./purchaseReturnView";
import { usePurchaseReturnActions } from "./usePurchaseReturnActions";

export default function PurchaseReturnRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { purchaseReturn, view, refresh } = usePurchaseReturnView(
    isNew ? null : id,
    formatCurrency,
  );

  const { actions, dialogs } = usePurchaseReturnActions(purchaseReturn, {
    onChanged: refresh,
    onDeleted: () => navigate("/purchases/returns"),
  });

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New purchase return"
        actions={actions}
      />
      {dialogs}
    </>
  );
}
