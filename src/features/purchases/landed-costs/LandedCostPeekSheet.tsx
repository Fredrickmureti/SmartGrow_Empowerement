/**
 * LandedCostPeekSheet — the drawer projection of `useLandedCostView`.
 * Same descriptor, same action vocabulary as the record page.
 */
import { PeekScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { useLandedCostView } from "./landedCostView";
import { useLandedCostActions } from "./useLandedCostActions";

interface Props {
  voucherId: string | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}

export function LandedCostPeekSheet({ voucherId, onOpenChange, onChanged }: Props) {
  const { formatCurrency } = useCurrency();
  const { record, view, refresh } = useLandedCostView(voucherId, formatCurrency);
  const { actions, dialogs } = useLandedCostActions(record, {
    onChanged: () => {
      refresh();
      onChanged?.();
    },
    onDeleted: () => {
      onOpenChange(false);
      onChanged?.();
    },
  });

  return (
    <>
      <PeekScaffold
        {...view}
        open={!!voucherId}
        onOpenChange={onOpenChange}
        fullPageHref={record ? `/purchases/landed-costs/${record.voucher.id}` : undefined}
        extraHeaderActions={
          record
            ? actions
                .filter((a) => a.primary && !a.hidden)
                .map((a) => (
                  <Button
                    key={a.id}
                    size="sm"
                    disabled={a.disabled}
                    title={a.disabledReason}
                    onClick={() => a.onSelect()}
                  >
                    {a.icon && <a.icon className="mr-1.5 h-4 w-4" />} {a.label}
                  </Button>
                ))
            : undefined
        }
      />
      {dialogs}
    </>
  );
}

export default LandedCostPeekSheet;
