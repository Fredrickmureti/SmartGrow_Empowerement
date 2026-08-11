/**
 * ExpensePeekSheet — standard peek surface for one Expense on
 * `/purchases/expenses?peek=<id>`. Mirrors every other Purchases peek by
 * composing `PeekScaffold` over `expenseView`'s shared descriptor.
 *
 * Actions are affordances only: void and the two employee-reimbursement
 * routes are all server commands owned by `expenseCommands`. The
 * settleability predicate comes from `describeExpenseSettlement`, the same
 * derivation the list row menu uses, so the two surfaces cannot disagree.
 */
import { Wallet, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { describeExpenseSettlement } from "@/lib/finance/expenseCommands";
import { useExpenseView } from "./expenseView";

interface Props {
  expenseId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Optional void handler for approved/paid expenses. */
  onVoid?: (id: string) => void;
  /** Open the settlement dialog for an outstanding employee reimbursement. */
  onReimburse?: (id: string) => void;
  /** Take an expense back out of the payroll reimbursement queue. */
  onUnqueuePayroll?: (id: string) => void;
}

export function ExpensePeekSheet({
  expenseId,
  onOpenChange,
  onVoid,
  onReimburse,
  onUnqueuePayroll,
}: Props) {
  const { formatCurrency } = useCurrency();
  const { record, view } = useExpenseView(expenseId, formatCurrency);
  const isLocked = record?.status === "approved" || record?.status === "paid";
  const canVoid = !!(onVoid && record && isLocked);

  const settlement = record
    ? describeExpenseSettlement(
        record as Parameters<typeof describeExpenseSettlement>[0],
      )
    : null;
  const canSettle = !!(record && settlement?.canSettle);

  const close = () => onOpenChange(false);

  return (
    <PeekScaffold
      {...view}
      open={!!expenseId}
      onOpenChange={onOpenChange}
      fullPageHref={undefined}
      extraHeaderActions={
        canSettle || canVoid ? (
          <>
            {canSettle && settlement?.queued && onUnqueuePayroll && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onUnqueuePayroll(record!.id);
                  close();
                }}
              >
                <X className="mr-2 h-4 w-4" />
                Remove from payroll queue
              </Button>
            )}
            {canSettle && !settlement?.queued && onReimburse && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onReimburse(record!.id);
                  close();
                }}
              >
                <Wallet className="mr-2 h-4 w-4" />
                Reimburse employee
              </Button>
            )}
            {canVoid && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onVoid!(record!.id);
                  close();
                }}
                className="text-destructive hover:text-destructive"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Void expense
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );
}

export default ExpensePeekSheet;
