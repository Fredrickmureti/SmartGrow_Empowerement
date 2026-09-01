/**
 * Approve or reject an application (C5).
 *
 * The approved amount and term are decided facts, distinct from what was
 * requested. Legality of the transition, decision authority, the presence of an
 * assessment and the product band are all enforced by the database guard — a
 * refusal surfaces here as its message.
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
import { useMfLoanProductVersions } from "@/hooks/useMfLoanProducts";
import type { MfLoanApplication } from "@/hooks/useMfApplications";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: MfLoanApplication | null;
  mode: "approve" | "reject";
  onApprove: (input: {
    id: string;
    approved_amount: number;
    approved_term_installments: number;
    decision_notes: string | null;
  }) => Promise<void>;
  onReject: (input: { id: string; rejection_reason: string }) => Promise<void>;
}

export function DecisionDialog({
  open,
  onOpenChange,
  application,
  mode,
  onApprove,
  onReject,
}: Props) {
  const { currentVersion } = useMfLoanProductVersions(application?.product_id ?? null);
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [term, setTerm] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open || !application) return;
    setAmount(String(application.approved_amount ?? application.requested_amount));
    setTerm(
      String(
        application.approved_term_installments ?? application.requested_term_installments,
      ),
    );
    setNotes("");
    setReason("");
  }, [open, application]);

  const numericAmount = Number(amount);
  const numericTerm = Number(term);
  const approveValid =
    Number.isFinite(numericAmount) && numericAmount > 0 &&
    Number.isFinite(numericTerm) && numericTerm > 0;

  const submit = async () => {
    if (!application) return;
    setSaving(true);
    try {
      if (mode === "approve") {
        if (!approveValid) return;
        await onApprove({
          id: application.id,
          approved_amount: numericAmount,
          approved_term_installments: numericTerm,
          decision_notes: notes.trim() || null,
        });
      } else {
        if (reason.trim() === "") return;
        await onReject({ id: application.id, rejection_reason: reason.trim() });
      }
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "approve" ? "Approve application" : "Reject application"}
          </DialogTitle>
          <DialogDescription>
            {application
              ? `${application.application_number} — requested ${application.requested_amount} over ${application.requested_term_installments} installments.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {mode === "approve" ? (
          <div className="space-y-4">
            {currentVersion && (
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Product band: {currentVersion.currency_code} {currentVersion.min_amount}–
                {currentVersion.max_amount}, {currentVersion.min_term_installments}–
                {currentVersion.max_term_installments} installments.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="approved_amount">Approved amount</Label>
                <Input
                  id="approved_amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="approved_term">Approved installments</Label>
                <Input
                  id="approved_term"
                  inputMode="numeric"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="decision_notes">Decision notes</Label>
              <Textarea
                id="decision_notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Authority exercised, conditions attached…"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="rejection_reason">Reason for rejection</Label>
            <Textarea
              id="rejection_reason"
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={mode === "approve" ? "default" : "destructive"}
            onClick={submit}
            disabled={saving || (mode === "approve" ? !approveValid : reason.trim() === "")}
          >
            {saving ? "Saving…" : mode === "approve" ? "Approve" : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DecisionDialog;
