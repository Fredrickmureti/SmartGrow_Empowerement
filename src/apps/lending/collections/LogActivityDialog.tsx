/**
 * Lending → Collections: record a collection activity (C7b).
 *
 * A collection activity is a business event: it is attributed to the acting
 * officer, append-only, and never edits loan financial state.
 */
import { useState } from "react";
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
import {
  MF_ACTIVITY_OUTCOMES,
  MF_ACTIVITY_TYPES,
  useMfCollectionActivities,
} from "@/hooks/useMfCollections";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: { loan_id: string; client_id: string; branch_id: string | null; loan_number: string } | null;
}

export function LogActivityDialog({ open, onOpenChange, loan }: Props) {
  const { logActivity } = useMfCollectionActivities();
  const [activityType, setActivityType] = useState("call");
  const [outcome, setOutcome] = useState<string>("contacted");
  const [promiseAmount, setPromiseAmount] = useState("");
  const [promiseDate, setPromiseDate] = useState("");
  const [notes, setNotes] = useState("");

  const isPromise = activityType === "promise_to_pay" || outcome === "promised";

  const reset = () => {
    setActivityType("call");
    setOutcome("contacted");
    setPromiseAmount("");
    setPromiseDate("");
    setNotes("");
  };

  const submit = async () => {
    if (!loan) return;
    await logActivity.mutateAsync({
      loanId: loan.loan_id,
      clientId: loan.client_id,
      branchId: loan.branch_id,
      activityType,
      outcome,
      promiseAmount: isPromise && promiseAmount ? Number(promiseAmount) : null,
      promiseDate: isPromise && promiseDate ? promiseDate : null,
      notes: notes.trim() || null,
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record collection activity</DialogTitle>
          <DialogDescription>
            Loan {loan?.loan_number ?? "—"} · recorded against your officer identity and kept
            permanently.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Activity</Label>
              <Select value={activityType} onValueChange={setActivityType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MF_ACTIVITY_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Outcome</Label>
              <Select value={outcome} onValueChange={setOutcome}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MF_ACTIVITY_OUTCOMES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isPromise ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Promised amount</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={promiseAmount}
                  onChange={(e) => setPromiseAmount(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Promised date</Label>
                <Input
                  type="date"
                  value={promiseDate}
                  onChange={(e) => setPromiseDate(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label>Notes</Label>
            <Textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened, what was agreed, next step…"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Recording an activity does not post money. Payments are captured under Repayments.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!loan || logActivity.isPending}>
            {logActivity.isPending ? "Saving…" : "Record activity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
