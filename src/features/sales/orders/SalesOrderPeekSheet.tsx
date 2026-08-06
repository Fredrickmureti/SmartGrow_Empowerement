/**
 * SalesOrderPeekSheet — the drawer projection of `useSalesOrderView`.
 * Read-oriented; fulfillment and conversion stay in the list row menu.
 */
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useSalesOrderView } from "./salesOrderView";

interface Props {
  salesOrderId: string | null;
  onOpenChange: (o: boolean) => void;
}

export function SalesOrderPeekSheet({ salesOrderId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { order, view } = useSalesOrderView(salesOrderId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!salesOrderId}
      onOpenChange={onOpenChange}
      fullPageHref={order ? `/sales/orders/${order.id}` : undefined}
    />
  );
}

export default SalesOrderPeekSheet;
