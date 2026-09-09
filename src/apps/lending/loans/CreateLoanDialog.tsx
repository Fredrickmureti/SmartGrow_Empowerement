/**
 * Mint a contractual loan from an approved application (C6).
 *
 * Terms are not entered here: the server copies the approved amount/term and
 * the frozen product version onto the loan and generates the schedule. The
 * operator only chooses the value dates.
 *
 * The picker mirrors what `mf_create_loan_from_application` actually accepts —
 * an approved application, or one already marked ready for disbursement, that
 * does not yet have a loan. Narrowing it further than the guard would leave
 * applications stranded with no way forward.
 */
import { useEffect, useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMfApplications } from "@/hooks/useMfApplications";
import { useMfClients } from "@/hooks/useMfClients";
import { useMfLoans } from "@/hooks/useMfLoans";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Application to pre-select when the dialog is opened from the pipeline. */
  presetApplicationId?: string | null;
  onCreate: (input: {
    applicationId: string;
    expectedDisbursementDate: string;
    firstInstallmentDate: string | null;
  }) => Promise<void>;
}

const today = () => new Date().toISOString().slice(0, 10);

export function CreateLoanDialog({
  open,
  onOpenChange,
  presetApplicationId,
  onCreate,
}: Props) {
  const { applications } = useMfApplications({ status: "all" });
  const { clients } = useMfClients();
  const { loans } = useMfLoans({ status: "all" });
  const [applicationId, setApplicationId] = useState("");
  const [expected, setExpected] = useState(today());
  const [firstDue, setFirstDue] = useState("");
  const [saving, setSaving] = useState(false);

  const loanedApplicationIds = useMemo(
    () => new Set(loans.map((l) => l.application_id).filter(Boolean) as string[]),
    [loans],
  );

  const eligible = useMemo(
    () =>
      applications.filter(
        (a) =>
          (a.status === "approved" || a.status === "ready_for_disbursement") &&
          !loanedApplicationIds.has(a.id),
      ),
    [applications, loanedApplicationIds],
  );

  const clientLabel = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "Client";
  }, [clients]);

  useEffect(() => {
    if (!open) return;
    setApplicationId(presetApplicationId ?? "");
    setExpected(today());
    setFirstDue("");
  }, [open, presetApplicationId]);

  const submit = async () => {
    if (!applicationId) return;
    setSaving(true);
    try {
      await onCreate({
        applicationId,
        expectedDisbursementDate: expected,
        firstInstallmentDate: firstDue || null,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create loan</DialogTitle>
          <DialogDescription>
            The approved amount, term and the frozen product version are carried over by
            the system. The repayment schedule is generated server-side. Creating the loan
            does not pay any money out — disbursement is a separate step.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Approved application</Label>
            <Select value={applicationId} onValueChange={setApplicationId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an approved application" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.application_number} · {clientLabel(a.client_id)} ·{" "}
                    {a.approved_amount ?? a.requested_amount}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {eligible.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No approved applications are waiting. Approve one first.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="expected">Expected disbursement</Label>
              <Input
                id="expected"
                type="date"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="firstDue">First installment (optional)</Label>
              <Input
                id="firstDue"
                type="date"
                value={firstDue}
                onChange={(e) => setFirstDue(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !applicationId}>
            {saving ? "Creating…" : "Create loan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
