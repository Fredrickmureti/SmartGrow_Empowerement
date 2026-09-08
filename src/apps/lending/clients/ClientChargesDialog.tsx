/**
 * Admission fee on a client record: status, raise, record payment, reverse,
 * receipt. Every money action is a server routine; this dialog collects
 * intent only.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { StatusBadge } from "@/design-system";
import { MF_REPAYMENT_METHODS } from "@/hooks/useMfRepayments";
import {
  useMfClientCharges,
  useMfClientFeePolicy,
  type MfClientCharge,
  type MfClientChargeStatus,
} from "@/hooks/useMfClientCharges";
import type { MfClient } from "@/hooks/useMfClients";
import { LendingDocumentsMenu } from "../documents/LendingDocumentsMenu";

const TONE: Record<MfClientChargeStatus, "neutral" | "success" | "warning" | "danger"> = {
  outstanding: "warning",
  paid: "success",
  reversed: "neutral",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: MfClient | null;
  canManage: boolean;
}

export function ClientChargesDialog({ open, onOpenChange, client, canManage }: Props) {
  const { policy } = useMfClientFeePolicy();
  const { charges, isLoading, raiseAdmissionFee, payCharge, reverseCharge } = useMfClientCharges(
    client?.id ?? null,
  );

  const [mode, setMode] = useState<"view" | "pay" | "reverse">("view");
  const [target, setTarget] = useState<MfClientCharge | null>(null);
  const [paidOn, setPaidOn] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("view");
    setTarget(null);
    setPaidOn(new Date().toISOString().slice(0, 10));
    setMethod("cash");
    setReference("");
    setNotes("");
    setReason("");
  }, [open]);

  const admission = charges.filter((c) => c.kind === "admission_fee");
  const live = admission.find((c) => c.status !== "reversed") ?? null;
  const feeActive = !!policy?.admission_fee_active && (policy.admission_fee_amount ?? 0) > 0;
  const busy = raiseAdmissionFee.isPending || payCharge.isPending || reverseCharge.isPending;

  const fmt = (c: MfClientCharge) => `${c.currency_code} ${Number(c.amount).toLocaleString()}`;

  const submitPay = async () => {
    if (!target) return;
    try {
      await payCharge.mutateAsync({
        chargeId: target.id,
        paidOn,
        method,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      });
      setMode("view");
    } catch {
      // toast already shown by the mutation
    }
  };

  const submitReverse = async () => {
    if (!target || !reason.trim()) return;
    try {
      await reverseCharge.mutateAsync({ chargeId: target.id, reason: reason.trim() });
      setMode("view");
    } catch {
      // toast already shown by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Admission fee — {client?.full_name ?? ""}</DialogTitle>
          <DialogDescription>
            {feeActive
              ? `Institution policy: ${policy?.admission_fee_currency ?? ""} ${Number(
                  policy?.admission_fee_amount ?? 0,
                ).toLocaleString()} one-time, posted to fee income when paid.`
              : "No admission fee is configured for this institution."}
          </DialogDescription>
        </DialogHeader>

        {mode === "view" && (
          <div className="space-y-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : admission.length === 0 ? (
              <p className="text-sm text-muted-foreground">No admission fee raised yet.</p>
            ) : (
              admission.map((c) => (
                <div key={c.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{fmt(c)}</span>
                    <StatusBadge tone={TONE[c.status]}>{c.status}</StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Raised {c.charged_on}
                    {c.paid_on ? ` · paid ${c.paid_on} by ${c.method?.replace(/_/g, " ")}` : ""}
                    {c.receipt_number ? ` · receipt ${c.receipt_number}` : ""}
                    {c.reference ? ` · ref ${c.reference}` : ""}
                    {c.reversed_at ? ` · reversed: ${c.reversal_reason ?? ""}` : ""}
                  </p>
                  <div className="mt-2 flex items-center justify-end gap-2">
                    {c.receipt_number && (
                      <LendingDocumentsMenu
                        documents={[
                          {
                            documentType: "client_charge_receipt",
                            documentId: c.id,
                            title: "Admission Fee Receipt",
                            filename: `admission-receipt-${c.receipt_number}`,
                          },
                        ]}
                      />
                    )}
                    {canManage && c.status === "outstanding" && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setTarget(c);
                          setMode("pay");
                        }}
                      >
                        Record payment
                      </Button>
                    )}
                    {canManage && c.status === "paid" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setTarget(c);
                          setMode("reverse");
                        }}
                      >
                        Reverse
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {mode === "pay" && target && (
          <div className="grid gap-3">
            <p className="text-sm">
              Recording payment of <span className="font-medium">{fmt(target)}</span>.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Paid on</Label>
                <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Method</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MF_REPAYMENT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Notes</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        )}

        {mode === "reverse" && target && (
          <div className="grid gap-3">
            <p className="text-sm">
              Reversing payment of <span className="font-medium">{fmt(target)}</span>
              {target.receipt_number ? ` (receipt ${target.receipt_number})` : ""}. The original
              record and receipt are kept; a reversing ledger entry is created.
            </p>
            <div className="grid gap-1.5">
              <Label>Reason</Label>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
        )}

        <DialogFooter>
          {mode === "view" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {canManage && feeActive && !live && (
                <Button
                  disabled={busy}
                  onClick={() => raiseAdmissionFee.mutate({})}
                >
                  {raiseAdmissionFee.isPending ? "Raising…" : "Raise admission fee"}
                </Button>
              )}
            </>
          ) : mode === "pay" ? (
            <>
              <Button variant="outline" onClick={() => setMode("view")}>
                Back
              </Button>
              <Button onClick={submitPay} disabled={busy || !paidOn}>
                {payCharge.isPending ? "Recording…" : "Record payment"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setMode("view")}>
                Back
              </Button>
              <Button variant="destructive" onClick={submitReverse} disabled={busy || !reason.trim()}>
                {reverseCharge.isPending ? "Reversing…" : "Reverse payment"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
