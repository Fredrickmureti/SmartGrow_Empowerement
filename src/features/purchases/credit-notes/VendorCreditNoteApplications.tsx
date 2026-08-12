/**
 * VendorCreditNoteApplications — the settlement ledger of a vendor credit
 * note, and the two operator actions that move it (ADR 0132 Phase 7).
 *
 * "Apply oldest first" (FIFO) stays on the document action menu. This panel
 * adds the targeted case a controller actually needs: put *this much* credit
 * on *that* bill, and take it back off again when the allocation was wrong.
 * Both paths are server-authoritative — the browser picks the bill and the
 * amount, `apply_vendor_credit_to_bill_atomic` /
 * `unapply_vendor_credit_from_bill_atomic` decide whether it is allowed and
 * write the bill, the credit movement and the journal entry.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Undo2 } from "lucide-react";

import { Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { useVendorCreditNotes, type VendorCreditNote } from "@/hooks/useVendorCreditNotes";
import { useVendorCreditNoteApplications } from "./useVendorCreditNoteApplications";
import { useVendorOpenBills } from "./useVendorOpenBills";

interface Props {
  creditNote: VendorCreditNote;
  formatCurrency: (v: number) => string;
  onChanged?: () => void;
}

export function VendorCreditNoteApplications({ creditNote, formatCurrency, onChanged }: Props) {
  const { toast } = useToast();
  const { applyToBill, unapplyCreditApplication } = useVendorCreditNotes();
  const { applications, loading, refetch } = useVendorCreditNoteApplications(creditNote.id);
  const { bills, loading: billsLoading } = useVendorOpenBills(
    creditNote.vendor_id,
    creditNote.business_id,
  );

  const [open, setOpen] = useState(false);
  const [billId, setBillId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const posted = (creditNote.accounting_status ?? "unposted") === "posted";
  const remaining = (creditNote.total ?? 0) - (creditNote.amount_applied ?? 0);
  const canApply = posted && remaining > 0.01;

  const selectedBill = bills.find((b) => b.id === billId);
  const billBalance = selectedBill
    ? (selectedBill.total ?? 0) - (selectedBill.amount_paid ?? 0)
    : 0;
  const maxAmount = Math.min(remaining, billBalance || remaining);
  const parsed = Number(amount);
  const amountInvalid =
    !billId || !Number.isFinite(parsed) || parsed <= 0 || parsed > maxAmount + 0.01;

  const done = async (label: string) => {
    toast({ title: label });
    await refetch();
    onChanged?.();
  };

  const submitApply = async () => {
    setBusy(true);
    try {
      await applyToBill(creditNote.id, billId, Number(amount));
      setOpen(false);
      setBillId("");
      setAmount("");
      await done("Credit applied");
    } catch (error: unknown) {
      toast({
        title: "Could not apply credit",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const submitUnapply = async (applicationId: string) => {
    setBusy(true);
    try {
      await unapplyCreditApplication(applicationId, "Unapplied from the credit note record");
      await done("Credit unapplied");
    } catch (error: unknown) {
      toast({
        title: "Could not unapply credit",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Applications"
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={!canApply}
          title={
            canApply
              ? undefined
              : posted
                ? "This credit is fully applied."
                : "Only a posted credit note can be applied."
          }
          onClick={() => {
            setBillId("");
            setAmount("");
            setOpen(true);
          }}
        >
          Apply to a bill
        </Button>
      }
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading applications…</p>
      ) : applications.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None of this credit has been applied yet. {formatCurrency(Math.max(remaining, 0))} is
          available against this supplier's open bills.
        </p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {applications.map((app) => (
            <li key={app.id} className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {app.bill_id ? (
                    <Link
                      to={`/purchases/bills/${app.bill_id}`}
                      className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                    >
                      {app.bill?.bill_number ?? "Bill"}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </Link>
                  ) : (
                    <span className="font-medium">Bill</span>
                  )}
                  {app.reversed_at ? <Badge variant="outline">Unapplied</Badge> : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {new Date(app.applied_at).toLocaleDateString()}
                  {app.reversed_at
                    ? ` · unapplied ${new Date(app.reversed_at).toLocaleDateString()}`
                    : ""}
                  {app.notes ? ` · ${app.notes}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={app.reversed_at ? "text-muted-foreground line-through" : "font-medium"}>
                  {formatCurrency(app.amount ?? 0)}
                </span>
                {!app.reversed_at ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void submitUnapply(app.id)}
                  >
                    <Undo2 className="mr-1 h-3 w-3" aria-hidden />
                    Unapply
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply credit to a bill</DialogTitle>
            <DialogDescription>
              {formatCurrency(Math.max(remaining, 0))} of this credit is unapplied. The server
              re-checks the bill balance, the supplier match and the available credit before
              posting the settlement entry.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="vcn-apply-bill">Open bill</Label>
              <Select value={billId} onValueChange={setBillId}>
                <SelectTrigger id="vcn-apply-bill">
                  <SelectValue
                    placeholder={billsLoading ? "Loading bills…" : "Select an open bill"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {bills.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.bill_number ?? "Bill"} ·{" "}
                      {formatCurrency((b.total ?? 0) - (b.amount_paid ?? 0))} due
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!billsLoading && bills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  This supplier has no outstanding bills to settle.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="vcn-apply-amount">Amount</Label>
              <Input
                id="vcn-apply-amount"
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={selectedBill ? String(maxAmount.toFixed(2)) : "0.00"}
              />
              {selectedBill ? (
                <p className="text-xs text-muted-foreground">
                  Up to {formatCurrency(maxAmount)} — the lower of the unapplied credit and the
                  bill balance.
                </p>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || amountInvalid} onClick={() => void submitApply()}>
              Apply credit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
