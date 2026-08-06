/**
 * PurchaseOrderPeekSheet — the drawer projection of `usePurchaseOrderView`.
 */
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseOrderView } from "./purchaseOrderView";

interface Props {
  poId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function PurchaseOrderPeekSheet({ poId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { po, view } = usePurchaseOrderView(poId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!poId}
      onOpenChange={onOpenChange}
      fullPageHref={po ? `/purchases/orders/${po.id}` : undefined}
    />
  );
}

export default PurchaseOrderPeekSheet;
