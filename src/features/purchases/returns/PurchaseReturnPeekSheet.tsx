/**
 * PurchaseReturnPeekSheet — the drawer projection of
 * `usePurchaseReturnView`. Lifecycle actions come from the shared
 * `usePurchaseReturnActions` vocabulary; Edit is only offered on drafts,
 * because that is the only state the server lets a client amend.
 */
import { Link } from "react-router-dom";
import { Pencil } from "lucide-react";

import { PeekScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseReturnView } from "./purchaseReturnView";
import { usePurchaseReturnActions } from "./usePurchaseReturnActions";

interface Props {
  returnId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function PurchaseReturnPeekSheet({ returnId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { purchaseReturn, view, refresh } = usePurchaseReturnView(returnId, formatCurrency);
  const { actions, dialogs } = usePurchaseReturnActions(purchaseReturn, {
    onChanged: refresh,
  });
  const isDraft =
    purchaseReturn?.status === "draft" || purchaseReturn?.status === "pending";

  return (
    <>
      <PeekScaffold
        {...view}
        open={!!returnId}
        onOpenChange={onOpenChange}
        actions={actions}
        fullPageHref={purchaseReturn ? `/purchases/returns/${purchaseReturn.id}` : undefined}
        extraHeaderActions={
          purchaseReturn && isDraft ? (
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
      {dialogs}
    </>
  );
}

export default PurchaseReturnPeekSheet;
