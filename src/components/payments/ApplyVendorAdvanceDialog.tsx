/**
 * ADR 0028 — D6.1.
 *
 * ApplyVendorAdvanceDialog: consumes supplier cash already parked on the
 * Vendor Credits asset account against a specific open bill.
 *
 *   DR  Accounts Payable   <amount>
 *   CR  Vendor Credits     <amount>
 *
 * Deliberately NOT routed through `recordMultiBillPayment`: that engine
 * credits Bank, which would count the same cash out twice. Wraps
 * `apply_vendor_advance_atomic`, the AP mirror of
 * `apply_customer_deposit_atomic`. Idempotent on `client_request_id`.
 */
import { useEffect, useMemo, useState } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Banknote, ArrowDown } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useBills } from "@/hooks/useBills";
import { useVendorUnappliedAdvances } from "@/hooks/useVendorUnappliedAdvances";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface ApplyVendorAdvanceDialogProps {
  /** Supplier to scope advances + bills to. */
  vendorId: string | null;
  /** Optional: pre-select an advance (bill_payment id). */
  initialBillPaymentId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface OpenBill {
  id: string;
  bill_number: string;
  total: number;
  amount_paid: number;
  balance: number;
  bill_date: string;
}

export function ApplyVendorAdvanceDialog({
  vendorId,
  initialBillPaymentId,
  open,
  onOpenChange,
  onSuccess,
}: ApplyVendorAdvanceDialogProps) {
  const { applyVendorAdvance } = useBills();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { advances, isLoading: advancesLoading } = useVendorUnappliedAdvances(vendorId);

  const [billPaymentId, setBillPaymentId] = useState("");
  const [billId, setBillId] = useState("");
  const [amount, setAmount] = useState("");
  const [applyDate, setApplyDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBillPaymentId(initialBillPaymentId ?? (advances.length === 1 ? advances[0].id : ""));
    setBillId("");
    setAmount("");
    setApplyDate(new Date().toISOString().slice(0, 10));
  }, [open, initialBillPaymentId, advances.length]);

  const selectedAdvance = useMemo(
    () => advances.find((a) => a.id === billPaymentId) ?? null,
    [advances, billPaymentId],
  );

  const { data: bills = [], isLoading: billsLoading } = useQuery({
    queryKey: ["open-bills-for-advance", vendorId, currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<OpenBill[]> => {
      if (!vendorId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("bills")
        .select("id, bill_number, total, amount_paid, bill_date, status")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("vendor_id", vendorId)
        .in("status", ["open", "partial", "overdue"])
        .order("bill_date", { ascending: true });
      if (error) throw error;
      return (data ?? [])
        .map((b) => ({
          id: b.id as string,
          bill_number: (b.bill_number as string) ?? "",
          total: Number(b.total) || 0,
          amount_paid: Number(b.amount_paid) || 0,
          balance: (Number(b.total) || 0) - (Number(b.amount_paid) || 0),
          bill_date: b.bill_date as string,
        }))
        .filter((b) => b.balance > 0.005);
    },
    enabled: open && !!vendorId && !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
  });

  const selectedBill = useMemo(
    () => bills.find((b) => b.id === billId) ?? null,
    [bills, billId],
  );

  const maxApplicable = useMemo(() => {
    if (!selectedAdvance || !selectedBill) return 0;
    return Math.min(selectedAdvance.outstanding_amount, selectedBill.balance);
  }, [selectedAdvance, selectedBill]);

  useEffect(() => {
    if (maxApplicable > 0 && amount === "") setAmount(maxApplicable.toFixed(2));
  }, [maxApplicable, amount]);

  const numericAmount = Number(amount) || 0;
  const overCap = numericAmount > maxApplicable + 0.005;
  const validAmount = numericAmount > 0 && !overCap;
  const canSubmit = !!selectedAdvance && !!selectedBill && validAmount && !!applyDate && !submitting;

  const clientRequestId = useMemo(() => {
    if (!selectedAdvance || !selectedBill || !validAmount) return undefined;
    return `applyvadv-${selectedAdvance.id}-${selectedBill.id}-${Math.round(numericAmount * 100)}`;
  }, [selectedAdvance, selectedBill, numericAmount, validAmount]);

  const handleSubmit = async () => {
    if (!canSubmit || !selectedAdvance || !selectedBill) return;
    setSubmitting(true);
    try {
      const result = await applyVendorAdvance({
        billPaymentId: selectedAdvance.id,
        billId: selectedBill.id,
        amount: numericAmount,
        applyDate,
        clientRequestId,
      });

      toast({
        title: result?.idempotent_replay ? "Already applied" : "Advance applied",
        description: result?.idempotent_replay
          ? "This submission was a replay — the bill was not settled twice."
          : `${formatCurrency(numericAmount)} moved from vendor credits onto ${selectedBill.bill_number}.`,
      });

      queryClient.invalidateQueries({ queryKey: ["vendor-unapplied-advances"] });
      queryClient.invalidateQueries({ queryKey: ["open-bills-for-advance"] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      queryClient.invalidateQueries({ queryKey: ["vendor-ledger"] });
      onOpenChange(false);
      onSuccess?.();
    } catch (e) {
      toast({
        title: "Could not apply the advance",
        description: normalizeError(e).message,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={(o) => !submitting && onOpenChange(o)}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-primary" />
          Apply Vendor Credit to Bill
        </span>
      }
      description="Move money already paid to this supplier off the Vendor Credits account and onto a specific open bill. No further cash leaves the bank."
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
          }
          trailing={
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Apply Credit
            </Button>
          }
        />
      }
    >
      {advancesLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : advances.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          This supplier has no unapplied credit.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Unapplied advance</Label>
            <Select value={billPaymentId} onValueChange={setBillPaymentId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an advance…" />
              </SelectTrigger>
              <SelectContent>
                {advances.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex items-center justify-between gap-3 w-full">
                      <span>{a.reference || `Payment ${a.id.slice(0, 8)}`}</span>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(a.payment_date), "MMM d, yyyy")} ·{" "}
                        {formatCurrency(a.outstanding_amount)} available
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Open bill</Label>
            {billsLoading ? (
              <div className="flex items-center py-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : bills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This supplier has no bills with an outstanding balance.
              </p>
            ) : (
              <Select value={billId} onValueChange={setBillId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a bill…" />
                </SelectTrigger>
                <SelectContent>
                  {bills.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      <span className="flex items-center justify-between gap-3 w-full">
                        <span>{b.bill_number}</span>
                        <span className="text-xs text-muted-foreground">
                          Balance {formatCurrency(b.balance)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedAdvance && selectedBill && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="vadv-amount">Amount to apply</Label>
                  <Input
                    id="vadv-amount"
                    type="number"
                    step="0.01"
                    min="0"
                    max={maxApplicable}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Max {formatCurrency(maxApplicable)}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vadv-date">Apply date</Label>
                  <Input
                    id="vadv-date"
                    type="date"
                    value={applyDate}
                    onChange={(e) => setApplyDate(e.target.value)}
                  />
                </div>
              </div>
              {overCap && (
                <p className="text-xs text-destructive">
                  Amount exceeds the available credit or the bill balance.
                </p>
              )}

              {validAmount && (
                <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
                  <div className="font-medium flex items-center gap-2">
                    <ArrowDown className="h-4 w-4" />
                    Accounting preview
                  </div>
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1">
                    <span className="text-muted-foreground">DR Accounts Payable</span>
                    <span className="text-right tabular-nums">{formatCurrency(numericAmount)}</span>
                    <span />
                    <span className="text-muted-foreground">CR Vendor Credits</span>
                    <span />
                    <span className="text-right tabular-nums">{formatCurrency(numericAmount)}</span>
                  </div>
                  <div className="pt-2 mt-2 border-t flex justify-between">
                    <span className="text-muted-foreground">Bill balance after</span>
                    <span className="font-medium">
                      {formatCurrency(Math.max(0, selectedBill.balance - numericAmount))}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Credit remaining after</span>
                    <span className="font-medium">
                      {formatCurrency(Math.max(0, selectedAdvance.outstanding_amount - numericAmount))}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </DetailSheet>
  );
}
