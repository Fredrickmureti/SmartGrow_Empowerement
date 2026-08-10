/**
 * PurchaseOrderRecordPage — the full-page projection of
 * `usePurchaseOrderView`. Actions come from `usePurchaseOrderActions`, the
 * same vocabulary the list row menu offers, so the full page is never a
 * dead end.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseOrderView } from "./purchaseOrderView";
import { usePurchaseOrderActions } from "./usePurchaseOrderActions";

export default function PurchaseOrderRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { po, view, refresh } = usePurchaseOrderView(isNew ? null : id, formatCurrency);

  const { actions, dialogs } = usePurchaseOrderActions(po, {
    onChanged: refresh,
    onDeleted: () => navigate("/purchases/orders"),
  });

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New purchase order"
        actions={actions}
      />
      {dialogs}
    </>
  );
}
