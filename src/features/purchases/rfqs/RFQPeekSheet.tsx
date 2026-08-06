/**
 * RFQPeekSheet — the drawer projection of `useRFQView`.
 */
import { Link } from "react-router-dom";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PeekScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQView } from "./rfqView";

interface Props {
  rfqId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function RFQPeekSheet({ rfqId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { rfq, view } = useRFQView(rfqId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!rfqId}
      onOpenChange={onOpenChange}
      fullPageHref={rfq ? `/purchases/rfqs/${rfq.id}` : undefined}
      extraHeaderActions={
        rfq && rfq.status === "draft" ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={`/purchases/rfqs/${rfq.id}/edit`}
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

export default RFQPeekSheet;
