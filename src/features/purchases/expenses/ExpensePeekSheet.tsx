/**
 * ExpensePeekSheet — standard peek surface for one Expense on
 * `/purchases/expenses?peek=<id>`. Mirrors every other Purchases peek by
 * composing `PeekScaffold` over `expenseView`'s shared descriptor.
 */
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useExpenseView } from "./expenseView";

interface Props {
  expenseId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Optional void handler for approved/paid expenses. */
  onVoid?: (id: string) => void;
}

export function ExpensePeekSheet({ expenseId, onOpenChange, onVoid }: Props) {
  const { formatCurrency } = useCurrency();
  const { record, view } = useExpenseView(expenseId, formatCurrency);
  const isLocked = record?.status === "approved" || record?.status === "paid";
  const canVoid = !!(onVoid && record && isLocked);

  return (
    <PeekScaffold
      {...view}
      open={!!expenseId}
      onOpenChange={onOpenChange}
      fullPageHref={undefined}
      extraHeaderActions={
        canVoid ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onVoid!(record!.id);
              onOpenChange(false);
            }}
            className="text-destructive hover:text-destructive"
          >
            <XCircle className="mr-2 h-4 w-4" />
            Void expense
          </Button>
        ) : undefined
      }
    />
  );
}

export default ExpensePeekSheet;
