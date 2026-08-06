/**
 * PurchaseReturnRecordPage — the full-page projection of
 * `usePurchaseReturnView`. Owns routing and actions only; content comes
 * from the shared descriptor, which the peek sheet also renders.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseReturnView } from "./purchaseReturnView";

export default function PurchaseReturnRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { purchaseReturn, view } = usePurchaseReturnView(isNew ? null : id, formatCurrency);

  const isPending = purchaseReturn?.status === "pending";

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New purchase return"
      onEdit={
        purchaseReturn && isPending
          ? () => navigate(`/purchases/returns/${purchaseReturn.id}/edit`)
          : undefined
      }
    />
  );
}
