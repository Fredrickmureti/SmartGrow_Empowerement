/**
 * ADR 0028 — D6.1.
 *
 * RecordVendorAdvanceDialog: money paid to a supplier before any bill
 * exists. The cash is held on the Vendor Credits asset account, never as a
 * bill settlement:
 *
 *   DR  Vendor Credits   <amount>
 *   CR  Bank / Cash      <amount>
 *
 * Wraps `useBills().recordVendorAdvance` → `record_vendor_advance_payment`,
 * idempotent on the request key generated below so a double submit cannot
 * mint two advances.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Banknote, ArrowDown } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { applyPartyScope } from "@/lib/contactAddresses";
import { useBills } from "@/hooks/useBills";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface RecordVendorAdvanceDialogProps {
  /** Optional: pre-select a supplier. */
  initialVendorId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const PAYMENT_METHODS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
  { value: "mobile_money", label: "Mobile money" },
  { value: "other", label: "Other" },
];

export function RecordVendorAdvanceDialog({
  initialVendorId,
  open,
  onOpenChange,
  onSuccess,
}: RecordVendorAdvanceDialogProps) {
  const { recordVendorAdvance } = useBills();
  const { accounts: bankAccounts } = useBankAccounts();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [vendorId, setVendorId] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState("bank_transfer");
  const [bankAccountId, setBankAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /**
   * Stable per-attempt request key. Regenerated only when the dialog is
   * reopened, so a double-click or a retry after a network timeout replays
   * the same advance instead of creating a second one.
   */
  const requestIdRef = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    setVendorId(initialVendorId ?? "");
    setAmount("");
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setPaymentMethod("bank_transfer");
    setBankAccountId("");
    setReference("");
    setNotes("");
    requestIdRef.current = `vadv-${crypto.randomUUID()}`;
  }, [open, initialVendorId]);

  const { data: vendors = [], isLoading: vendorsLoading } = useQuery({
    queryKey: ["advance-vendor-options", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await applyPartyScope(
        supabase.from("contacts").select("id, name, type"),
      )
        .eq("organization_id", currentOrg.id)
        .in("type", ["supplier", "both"])
        .order("name");
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
    enabled: open && !!currentOrg?.id,
    staleTime: 60_000,
  });

  const numericAmount = Number(amount) || 0;
  const canSubmit = !!vendorId && numericAmount > 0 && !!paymentDate && !submitting;

  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === vendorId) ?? null,
    [vendors, vendorId],
  );

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await recordVendorAdvance({
        vendorId,
        amount: numericAmount,
        payment_date: paymentDate,
        payment_method: paymentMethod,
        reference: reference || null,
        notes: notes || null,
        bank_account_id: bankAccountId || null,
        requestId: requestIdRef.current,
      });

      toast({
        title: result?.idempotent_replay ? "Advance already recorded" : "Advance recorded",
        description: result?.idempotent_replay
          ? "This submission was a replay — no second payment was created."
          : `${formatCurrency(numericAmount)} is now held as a vendor credit for ${selectedVendor?.name ?? "this supplier"}.`,
      });

      queryClient.invalidateQueries({ queryKey: ["vendor-unapplied-advances"] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      onOpenChange(false);
      onSuccess?.();
    } catch (e) {
      toast({
        title: "Could not record the advance",
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
          Record Supplier Advance
        </span>
      }
      description="Money paid to a supplier before any bill exists. It is held as a vendor credit and can be applied to a bill later."
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
              Record Advance
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Supplier</Label>
          {vendorsLoading ? (
            <div className="flex items-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a supplier…" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="advance-amount">Amount</Label>
            <Input
              id="advance-amount"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="advance-date">Payment date</Label>
            <Input
              id="advance-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Payment method</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Paid from</Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Default cash/bank" />
              </SelectTrigger>
              <SelectContent>
                {(bankAccounts ?? []).map((a: { id: string; account_name?: string; name?: string }) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.account_name ?? a.name ?? "Account"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="advance-reference">Reference</Label>
          <Input
            id="advance-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Cheque no., transfer ref…"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="advance-notes">Notes</Label>
          <Textarea
            id="advance-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </div>

        {numericAmount > 0 && (
          <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
            <div className="font-medium flex items-center gap-2">
              <ArrowDown className="h-4 w-4" />
              Accounting preview
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1">
              <span className="text-muted-foreground">DR Vendor Credits</span>
              <span className="text-right tabular-nums">{formatCurrency(numericAmount)}</span>
              <span />
              <span className="text-muted-foreground">CR Bank / Cash</span>
              <span />
              <span className="text-right tabular-nums">{formatCurrency(numericAmount)}</span>
            </div>
            <p className="pt-2 mt-2 border-t text-xs text-muted-foreground">
              No bill is settled by this entry. Apply the credit to a bill when the
              supplier invoices you.
            </p>
          </div>
        )}
      </div>
    </DetailSheet>
  );
}
