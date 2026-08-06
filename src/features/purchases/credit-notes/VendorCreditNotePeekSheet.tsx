/**
 * VendorCreditNotePeekSheet — the drawer projection of
 * `useVendorCreditNoteView`. Apply-to-bill and refund actions stay on the
 * list row menu; Edit is surfaced here for drafts.
 */
import { Link } from "react-router-dom";
import { Pencil } from "lucide-react";

import { PeekScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { useVendorCreditNoteView } from "./vendorCreditNoteView";

interface Props {
  creditNoteId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function VendorCreditNotePeekSheet({ creditNoteId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { creditNote, view } = useVendorCreditNoteView(creditNoteId, formatCurrency);

  return (
    <PeekScaffold
      {...view}
      open={!!creditNoteId}
      onOpenChange={onOpenChange}
      fullPageHref={creditNote ? `/purchases/credit-notes/${creditNote.id}` : undefined}
      extraHeaderActions={
        creditNote && creditNote.status === "draft" ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={`/purchases/credit-notes/${creditNote.id}/edit`}
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

export default VendorCreditNotePeekSheet;
