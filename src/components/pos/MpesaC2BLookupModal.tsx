import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Smartphone, RefreshCw, CheckCircle2 } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { useMpesaC2BLookup, type UnmatchedC2B } from "@/hooks/pos/useMpesaC2BLookup";
import { cn } from "@/lib/utils";

interface MpesaC2BLookupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** POS transaction id to attach the C2B payment to. */
  posTransactionId: string | null;
  /** Outstanding balance (used to suggest amount-exact matches). */
  remaining: number;
  onAttached: (info: { transId: string; amount: number }) => void;
}

/**
 * Cashier "pull-side" M-Pesa flow: customer paid via paybill/till and
 * the cashier needs to find that C2B receipt and attach it to the open
 * POS sale. Mirrors the supermarket workflow.
 */
export function MpesaC2BLookupModal({
  open,
  onOpenChange,
  posTransactionId,
  remaining,
  onAttached,
}: MpesaC2BLookupModalProps) {
  const { formatCurrency } = useCurrency();
  const { recent, isLoading, isAttaching, refresh, attach } = useMpesaC2BLookup();
  const [query, setQuery] = useState("");
  const [exactAmountOnly, setExactAmountOnly] = useState(true);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setExactAmountOnly(true);
    refresh({ amount: remaining > 0 ? remaining : null, recentMinutes: 60 });
  }, [open, remaining, refresh]);

  const handleSearch = () => {
    refresh({
      amount: exactAmountOnly && remaining > 0 ? remaining : null,
      query,
      recentMinutes: 60,
    });
  };

  const handlePick = async (row: UnmatchedC2B) => {
    if (!posTransactionId) return;
    const result = await attach(row.id, posTransactionId);
    if (result) {
      onAttached({ transId: row.trans_id, amount: Number(row.trans_amount) });
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-[#4caf50] flex items-center justify-center">
              <Smartphone className="h-4 w-4 text-white" />
            </div>
            Look up M-Pesa payment
          </DialogTitle>
          <DialogDescription>
            Customer paid via paybill/till. Find their M-Pesa receipt and attach it to this sale.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">Remaining balance</p>
            <p className="text-2xl font-bold">{formatCurrency(remaining)}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="c2bQuery">Receipt code or phone</Label>
            <div className="flex gap-2">
              <Input
                id="c2bQuery"
                value={query}
                onChange={(e) => setQuery(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="e.g. RKL3X4Y9AB or 254712…"
                className="font-mono"
              />
              <Button onClick={handleSearch} disabled={isLoading}>
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={exactAmountOnly}
                onChange={(e) => setExactAmountOnly(e.target.checked)}
                className="h-3 w-3"
              />
              Only show payments matching {formatCurrency(remaining)} exactly
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">
                Unreconciled M-Pesa receipts
                {recent.length > 0 && (
                  <Badge variant="secondary" className="ml-2">{recent.length}</Badge>
                )}
              </Label>
              <Button variant="ghost" size="sm" onClick={handleSearch} disabled={isLoading}>
                <RefreshCw className={cn("h-3 w-3 mr-1", isLoading && "animate-spin")} />
                Refresh
              </Button>
            </div>

            {recent.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground border-2 border-dashed rounded-lg">
                {isLoading ? "Searching…" : "No matching M-Pesa payments in the last hour."}
                <br />
                <span className="text-xs">Tip: type the customer's M-Pesa code and press Enter.</span>
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {recent.map((row) => {
                  const exact = remaining > 0 && Math.abs(Number(row.trans_amount) - remaining) < 0.01;
                  const insufficient = Number(row.trans_amount) < remaining;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      disabled={isAttaching || insufficient || !posTransactionId}
                      onClick={() => handlePick(row)}
                      className={cn(
                        "w-full text-left p-3 rounded-lg border transition-colors",
                        "hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed",
                        exact && "border-primary bg-primary/5",
                      )}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold text-sm">{row.trans_id}</span>
                            {exact && (
                              <Badge variant="default" className="text-[10px]">
                                <CheckCircle2 className="h-3 w-3 mr-0.5" /> exact match
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {[row.first_name, row.last_name].filter(Boolean).join(" ") || "Unknown payer"}
                            {row.msisdn ? ` • ${row.msisdn}` : ""}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {new Date(row.trans_time).toLocaleString()}
                            {row.bill_ref_number ? ` • ref ${row.bill_ref_number}` : ""}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold">{formatCurrency(Number(row.trans_amount))}</p>
                          {insufficient && (
                            <p className="text-[10px] text-destructive">below balance</p>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isAttaching}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
