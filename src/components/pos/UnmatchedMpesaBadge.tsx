/**
 * UnmatchedMpesaBadge — global indicator in the POS shell that warns the
 * cashier when one or more recent paybill/till payments arrived without
 * being auto-matched to a sale.
 *
 * This is the "supermarket flow": the customer pays at the till on their
 * phone, and the cashier needs a single visible signal to know to open
 * the lookup and attach it to the open sale. Without this badge, cashiers
 * have no idea unsolicited C2B payments exist until they dig into reports.
 */
import { useState } from "react";
import { Smartphone, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMpesaC2BLookup } from "@/hooks/pos/useMpesaC2BLookup";
import { MpesaC2BLookupModal } from "./MpesaC2BLookupModal";
import { usePaymentProviders } from "@/hooks/usePaymentProviders";

export function UnmatchedMpesaBadge() {
  const [open, setOpen] = useState(false);
  const { recent, isLoading } = useMpesaC2BLookup();
  const { getProviderConfig } = usePaymentProviders();
  const isMpesaEnabled = getProviderConfig("mpesa")?.is_active;

  if (!isMpesaEnabled) return null;
  const count = recent.length;

  return (
    <>
      <Button
        variant={count > 0 ? "default" : "outline"}
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => setOpen(true)}
        title={
          count > 0
            ? `${count} unmatched M-Pesa payment${count === 1 ? "" : "s"} — click to attach`
            : "No unmatched M-Pesa payments"
        }
      >
        {isLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Smartphone className="h-3.5 w-3.5" />
        )}
        <span className="text-xs">M-Pesa</span>
        {count > 0 && (
          <Badge
            variant="secondary"
            className="ml-0.5 h-5 px-1.5 text-[10px] tabular-nums"
          >
            {count}
          </Badge>
        )}
      </Button>

      {/* In browse mode (no posTransactionId), the modal lets the cashier
          pick from the unmatched list and choose a held/open sale to
          attach against. */}
      <MpesaC2BLookupModal
        open={open}
        onOpenChange={setOpen}
        posTransactionId={null}
        remaining={0}
        onAttached={() => setOpen(false)}
      />
    </>
  );
}
