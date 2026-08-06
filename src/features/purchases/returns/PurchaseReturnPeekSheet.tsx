/**
 * PurchaseReturnPeekSheet — the drawer projection of
 * `usePurchaseReturnView`. Approve / process actions stay on the list row
 * menu; Edit is surfaced here for pending returns.
 */
import { Link } from "react-router-dom";
import { Pencil } from "lucide-react";

import { PeekScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseReturnView } from "./purchaseReturnView";

interface Props {
  returnId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function PurchaseReturnPeekSheet({ returnId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { purchaseReturn, view } = usePurchaseReturnView(returnId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!returnId}
      onOpenChange={onOpenChange}
      fullPageHref={purchaseReturn ? `/purchases/returns/${purchaseReturn.id}` : undefined}
      extraHeaderActions={
        purchaseReturn && purchaseReturn.status === "pending" ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={`/purchases/returns/${purchaseReturn.id}/edit`}
              onClick={() => onOpenChange(false)}
            >
              <Pencil className="mr-1.5 h-4 w-4" /> Edit
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}

export default PurchaseReturnPeekSheet;
