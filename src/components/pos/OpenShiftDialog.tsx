import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePOSShifts } from "@/hooks/pos/usePOSShifts";
import { DollarSign, History } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";

interface OpenShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerId: string;
  onShiftOpened: () => void;
}

export function OpenShiftDialog({ open, onOpenChange, registerId, onShiftOpened }: OpenShiftDialogProps) {
  const { openShift } = usePOSShifts(registerId);
  const { formatCurrency } = useCurrency();

  const [openingCash, setOpeningCash] = useState("");
  const [notes, setNotes] = useState("");
  // H4 — "Same as last close" prefill. Read the most recent CLOSED shift on
  // this register so the cashier can one-click prefill the opening float
  // instead of recounting & retyping every shift.
  const [lastClose, setLastClose] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !registerId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("pos_shifts")
        .select("actual_cash, expected_cash, closed_at")
        .eq("register_id", registerId)
        .not("closed_at", "is", null)
        .order("closed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const amt = (data?.actual_cash ?? data?.expected_cash) as number | null;
      setLastClose(typeof amt === "number" ? amt : null);
    })();
    return () => { cancelled = true; };
  }, [open, registerId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    await openShift.mutateAsync({
      register_id: registerId,
      opening_cash: parseFloat(openingCash) || 0,
      notes: notes || undefined,
    });
    
    setOpeningCash("");
    setNotes("");
    onShiftOpened();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">Open New Shift</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Count your cash drawer and enter the opening amount to start your shift.
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
          <div className="space-y-1.5 sm:space-y-2">
            <Label htmlFor="opening_cash" className="text-xs sm:text-sm">Opening Cash Amount</Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="opening_cash"
                type="number"
                step="0.01"
                min="0"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                className="pl-10 h-10 sm:h-9 text-base sm:text-sm"
                placeholder="0.00"
                autoFocus
              />
            </div>
            <p className="text-[10px] sm:text-xs text-muted-foreground">
              Enter the total cash in the drawer at the start of your shift.
            </p>
            {lastClose !== null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs gap-1.5"
                onClick={() => setOpeningCash(String(lastClose))}
              >
                <History className="h-3.5 w-3.5" />
                Use last close ({formatCurrency(lastClose)})
              </Button>
            )}
          </div>
          
          <div className="space-y-1.5 sm:space-y-2">
            <Label htmlFor="notes" className="text-xs sm:text-sm">Notes (Optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes about this shift..."
              rows={2}
              className="text-sm"
            />
          </div>
          
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button type="submit" disabled={openShift.isPending} className="w-full sm:w-auto">
              {openShift.isPending ? "Opening..." : "Start Shift"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
