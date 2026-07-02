import { useEffect, useMemo, useState } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Loader2 } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { usePaymentAllocations } from "@/hooks/usePaymentAllocations";
import {
  useReallocatePayment,
  useReallocationTargets,
  type NewAllocationInput,
} from "@/hooks/useReallocatePayment";

/**
 * ADR 0027 — ReallocatePaymentDialog
 *
 * Lets a user redistribute a recorded customer payment across a new set
 * of open invoices. Calls `reallocate_payment_atomic` which is append-only
 * at the DB level (compensating negative rows + new positive rows + a
 * `payment_reversal_events` audit entry).
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: {
    id: string;
    amount: number;
    contact_id: string | null;
    business_id?: string | null;
    currency?: string | null;
  } | null;
  onSuccess?: () => void;
}

export function ReallocatePaymentDialog({ open, onOpenChange, payment, onSuccess }: Props) {
  const { formatCurrency } = useCurrency();
  const { allocations: currentAllocations } = usePaymentAllocations(open ? payment?.id : null);

  const currentAllocationIds = useMemo(
    () => currentAllocations.map((a) => a.invoice_id),
    [currentAllocations],
  );

  const { data: targets = [], isLoading: targetsLoading } = useReallocationTargets({
    contactId: payment?.contact_id ?? null,
    businessId: payment?.business_id ?? null,
    currency: payment?.currency ?? null,
    includeInvoiceIds: currentAllocationIds,
  });

  const reallocate = useReallocatePayment();

  // Editable amount map keyed by invoice id
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");

  // Seed draft with current allocations whenever the dialog (re)opens
  useEffect(() => {
    if (!open) return;
    const seed: Record<string, string> = {};
    for (const a of currentAllocations) seed[a.invoice_id] = a.amount.toFixed(2);
    setDraft(seed);
    setReason("");
  }, [open, currentAllocations]);

  const paymentAmount = Number(payment?.amount) || 0;
  const totalDrafted = Object.values(draft).reduce((s, v) => s + (Number(v) || 0), 0);
  const remaining = paymentAmount - totalDrafted;

  // Validation
  const issues: string[] = [];
  if (totalDrafted > paymentAmount + 0.005) {
    issues.push(
      `Allocations total ${formatCurrency(totalDrafted)} exceed payment amount ${formatCurrency(paymentAmount)}.`,
    );
  }
  for (const t of targets) {
    const v = Number(draft[t.id] || 0);
    if (v <= 0) continue;
    // Remaining on the invoice excluding what this payment currently contributes
    const currentFromThisPayment =
      currentAllocations.find((a) => a.invoice_id === t.id)?.amount ?? 0;
    const otherRemaining = t.remaining + currentFromThisPayment;
    if (v > otherRemaining + 0.005) {
      issues.push(
        `Allocation of ${formatCurrency(v)} to ${t.invoice_number} exceeds its outstanding balance of ${formatCurrency(otherRemaining)}.`,
      );
    }
  }
  const hasAnyAllocation = Object.values(draft).some((v) => Number(v) > 0);
  if (!hasAnyAllocation) issues.push("At least one allocation row must be > 0.");

  const canSubmit = issues.length === 0 && !reallocate.isPending;

  const handleSubmit = async () => {
    if (!payment) return;
    const newAllocs: NewAllocationInput[] = Object.entries(draft)
      .map(([invoice_id, raw]) => ({ invoice_id, amount: Number(raw) || 0 }))
      .filter((a) => a.amount > 0);
    try {
      await reallocate.mutateAsync({
        paymentId: payment.id,
        newAllocations: newAllocs,
        reason: reason.trim() || undefined,
      });
      onOpenChange(false);
      onSuccess?.();
    } catch {
      // toast handled in hook
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Reallocate Payment"
      description="Redistribute this payment across the customer's open invoices. The change is append-only — prior allocations are compensated and a full audit trail is recorded."
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={reallocate.isPending}>
              Cancel
            </Button>
          }
          trailing={
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {reallocate.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Reallocate
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">

          <div className="grid grid-cols-3 gap-2 text-sm rounded-md border p-3 bg-muted/30">
            <div>
              <div className="text-muted-foreground text-xs">Payment</div>
              <div className="tabular-nums font-medium">{formatCurrency(paymentAmount)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Allocated</div>
              <div className="tabular-nums font-medium">{formatCurrency(totalDrafted)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">
                {remaining >= 0 ? "Unapplied" : "Over-allocated"}
              </div>
              <div
                className={`tabular-nums font-medium ${
                  remaining < -0.005 ? "text-destructive" : ""
                }`}
              >
                {formatCurrency(Math.abs(remaining))}
              </div>
            </div>
          </div>

          {targetsLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading invoices…
            </div>
          ) : targets.length === 0 ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                This customer has no open invoices in the payment's currency.
                Leaving all allocations at zero will turn the payment into a
                customer deposit.
              </AlertDescription>
            </Alert>
          ) : (
            <ScrollArea className="max-h-[40vh] rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b">
                    <th className="text-left px-3 py-2 font-medium">Invoice</th>
                    <th className="text-right px-3 py-2 font-medium">Total</th>
                    <th className="text-right px-3 py-2 font-medium">Remaining</th>
                    <th className="text-right px-3 py-2 font-medium">Allocate</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map((t) => {
                    const currentFromThisPayment =
                      currentAllocations.find((a) => a.invoice_id === t.id)?.amount ?? 0;
                    const available = t.remaining + currentFromThisPayment;
                    return (
                      <tr key={t.id} className="border-t">
                        <td className="px-3 py-2">
                          <div className="font-medium">{t.invoice_number}</div>
                          {t.due_date && (
                            <div className="text-xs text-muted-foreground">
                              Due {t.due_date}
                            </div>
                          )}
                          {currentFromThisPayment > 0 && (
                            <Badge variant="outline" className="mt-1 text-xs">
                              currently allocated
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(t.total)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(available)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            step="0.01"
                            className="w-28 text-right tabular-nums ml-auto"
                            value={draft[t.id] ?? ""}
                            onChange={(e) =>
                              setDraft((prev) => ({ ...prev, [t.id]: e.target.value }))
                            }
                            placeholder="0.00"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollArea>
          )}

          <div className="space-y-2">
            <Label htmlFor="realloc-reason">Reason (optional)</Label>
            <Textarea
              id="realloc-reason"
              placeholder="e.g. Customer requested payment moved from INV-2024-0042 to INV-2024-0050."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>

          {issues.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <ul className="list-disc pl-4 space-y-1">
                  {issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
      </div>
    </DetailSheet>
  );
}

