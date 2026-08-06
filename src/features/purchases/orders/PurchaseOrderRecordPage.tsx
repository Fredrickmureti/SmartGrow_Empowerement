/**
 * PurchaseOrderRecordPage — the full-page projection of
 * `usePurchaseOrderView`. Read-only in this pass; the legacy
 * `EditPODialog` stays as the editor until the Purchases wizard slice
 * lands.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseOrderView } from "./purchaseOrderView";

export default function PurchaseOrderRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { po, view } = usePurchaseOrderView(isNew ? null : id, formatCurrency);

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New purchase order"
      onEdit={po ? () => navigate(`/purchases/orders/${po.id}/edit`) : undefined}
    />
  );
}
