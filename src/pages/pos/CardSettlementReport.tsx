/**
 * Wave 2 · Phase F.4 — Card Settlement Report page.
 *
 * Shows the open + recently-closed acquirer batches for the current
 * business/branch, with expected vs actual variance and a manager-gated
 * Close button. Closing routes through `pos_close_card_settlement`
 * (SECURITY DEFINER) which enforces the manager role at the DB level
 * and emits `settlement.card.closed` to the outbox — the GL clearing
 * → bank posting is wired by the downstream handler.
 *
 * This page is intentionally read-heavy: no direct writes to
 * pos_card_settlements or pos_card_settlement_lines. The arch guard
 * `pos-card-settlement.test.ts` locks that in.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CreditCard, CheckCircle2, AlertTriangle, RefreshCcw } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { toast } from "sonner";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface Settlement {
  id: string;
  provider_key: string;
  batch_date: string;
  opened_at: string;
  closed_at: string | null;
  status: "open" | "closed" | "reconciled";
  expected_amount: number;
  actual_amount: number | null;
  variance: number | null;
  fee_total: number;
  notes: string | null;
  branch_id: string | null;
}

const STATUS_TONE: Record<string, string> = {
  open:        "bg-blue-500/10 text-blue-600 border-blue-500/30",
  closed:      "bg-green-500/10 text-green-600 border-green-500/30",
  reconciled:  "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
};

export default function CardSettlementReport() {
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const qc = useQueryClient();

  const [closeTarget, setCloseTarget] = useState<Settlement | null>(null);
  const [actualAmount, setActualAmount] = useState("");
  const [notes, setNotes] = useState("");

  const { data: settlements, isLoading } = useQuery<Settlement[]>({
    queryKey: ["pos_card_settlements", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pos_card_settlements")
        .select("*")
        .eq("business_id", currentBusiness!.id)
        .order("opened_at", { ascending: false })
        .limit(60);
      if (error) throw error;
      return (data ?? []) as unknown as Settlement[];
    },
  });

  const closeMut = useMutation({
    mutationFn: async (input: { id: string; actual: number; notes?: string }) => {
      const { data, error } = await supabase.rpc("pos_close_card_settlement", {
        p_settlement_id: input.id,
        p_actual_amount: input.actual,
        p_notes:         input.notes ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Batch closed");
      setCloseTarget(null);
      setActualAmount("");
      setNotes("");
      qc.invalidateQueries({ queryKey: ["pos_card_settlements"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Close failed"),
  });

  const openCloseDialog = (s: Settlement) => {
    setCloseTarget(s);
    setActualAmount(String(s.expected_amount ?? 0));
    setNotes("");
  };

  const confirmClose = () => {
    if (!closeTarget) return;
    const actual = Number(actualAmount);
    if (!Number.isFinite(actual)) {
      toast.error("Actual amount must be a number");
      return;
    }
    closeMut.mutate({ id: closeTarget.id, actual, notes: notes || undefined });
  };

  return (
    <div className="container max-w-5xl py-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CreditCard className="h-6 w-6" />
            Card Settlement Report
          </h1>
          <p className="text-muted-foreground text-sm">
            Acquirer batches for {currentBusiness?.name ?? "this business"}.
            Every capture and reversal is grouped into an open batch per provider;
            close a batch once the acquirer statement is received to compute variance.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries({ queryKey: ["pos_card_settlements"] })}
        >
          <RefreshCcw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : !settlements?.length ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            No card batches yet. They open automatically on the first card capture.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {settlements.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="capitalize">{s.provider_key}</span>
                      <Badge variant="outline" className={cn("text-xs", STATUS_TONE[s.status])}>
                        {s.status}
                      </Badge>
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Opened {format(new Date(s.opened_at), "MMM d, HH:mm")}
                      {s.closed_at && ` · Closed ${format(new Date(s.closed_at), "MMM d, HH:mm")}`}
                    </CardDescription>
                  </div>
                  {s.status === "open" && (
                    <Button size="sm" onClick={() => openCloseDialog(s)}>
                      <CheckCircle2 className="h-4 w-4 mr-1" />
                      Close batch
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2">
                <div>
                  <p className="text-xs text-muted-foreground">Expected</p>
                  <p className="font-semibold">{formatCurrency(s.expected_amount)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Actual</p>
                  <p className="font-semibold">
                    {s.actual_amount == null ? "—" : formatCurrency(s.actual_amount)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Variance</p>
                  <p className={cn(
                    "font-semibold",
                    s.variance == null ? "" :
                      s.variance === 0 ? "text-green-600" :
                        "text-orange-600",
                  )}>
                    {s.variance == null ? "—" : formatCurrency(s.variance)}
                    {s.variance != null && s.variance !== 0 && (
                      <AlertTriangle className="inline h-3 w-3 ml-1 text-orange-500" />
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Fees</p>
                  <p className="font-semibold">{formatCurrency(s.fee_total)}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!closeTarget} onOpenChange={(o) => !o && setCloseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close card batch</DialogTitle>
            <DialogDescription>
              Provider: <strong className="capitalize">{closeTarget?.provider_key}</strong>
              {" · "}Expected {closeTarget && formatCurrency(closeTarget.expected_amount)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="actual">Actual amount (from acquirer statement)</Label>
              <Input
                id="actual"
                type="number"
                step="0.01"
                value={actualAmount}
                onChange={(e) => setActualAmount(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="notes">Notes (optional)</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Reference the statement / discrepancy details…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCloseTarget(null)}>Cancel</Button>
            <Button onClick={confirmClose} disabled={closeMut.isPending}>
              {closeMut.isPending ? "Closing…" : "Close batch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
