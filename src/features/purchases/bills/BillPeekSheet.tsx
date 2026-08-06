/**
 * BillPeekSheet — the drawer projection of `useBillView`.
 *
 * Same descriptor as the full page. The peek stays read-oriented: all
 * record-affecting actions remain with the list's row action menu.
 */
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useBillView } from "./billView";

interface Props {
  billId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function BillPeekSheet({ billId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { bill, view } = useBillView(billId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!billId}
      onOpenChange={onOpenChange}
      fullPageHref={bill ? `/purchases/bills/${bill.id}` : undefined}
    />
  );
}

export default BillPeekSheet;
