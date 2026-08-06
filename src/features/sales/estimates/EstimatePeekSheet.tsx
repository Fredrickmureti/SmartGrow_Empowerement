/**
 * EstimatePeekSheet — the drawer projection of `useEstimateView`.
 * Read-oriented: quote lifecycle actions stay in the parent list row menu.
 */
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useEstimateView } from "./estimateView";

interface Props {
  estimateId: string | null;
  onOpenChange: (o: boolean) => void;
}

export function EstimatePeekSheet({ estimateId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { estimate, view } = useEstimateView(estimateId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!estimateId}
      onOpenChange={onOpenChange}
      fullPageHref={estimate ? `/sales/estimates/${estimate.id}` : undefined}
    />
  );
}

export default EstimatePeekSheet;
