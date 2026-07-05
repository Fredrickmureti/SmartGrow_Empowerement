/**
 * RenewContractDialog — thin dialog that wraps the `renew_contract` RPC
 * via `useRenewContract`. Used from the Expiring / Renewals / All queues.
 */
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRenewContract } from "@/hooks/hr/useContractAmendments";
import type { Contract } from "@/hooks/hr/useContracts";

interface Props {
  contract: Contract | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addYearISO(iso: string) {
  const d = new Date(iso);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export function RenewContractDialog({ contract, open, onOpenChange }: Props) {
  const renew = useRenewContract();
  const [newStart, setNewStart] = useState(todayISO());
  const [newEnd, setNewEnd] = useState("");
  const [newWage, setNewWage] = useState("");

  useEffect(() => {
    if (!open || !contract) return;
    const start = contract.end_date ?? todayISO();
    setNewStart(start);
    setNewEnd(addYearISO(start));
    setNewWage(contract.wage != null ? String(contract.wage) : "");
  }, [open, contract]);

  if (!contract) return null;

  const submit = async () => {
    await renew.mutateAsync({
      contractId: contract.id,
      newStart,
      newEnd: newEnd || null,
      newWage: newWage ? Number(newWage) : null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renew contract</DialogTitle>
          <DialogDescription>
            {contract.employee_name}
            {contract.contract_reference ? ` · ${contract.contract_reference}` : ""}
            {contract.end_date ? ` · current end ${contract.end_date}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="new-start">New start date</Label>
            <Input
              id="new-start"
              type="date"
              value={newStart}
              onChange={(e) => setNewStart(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-end">New end date (optional)</Label>
            <Input
              id="new-end"
              type="date"
              value={newEnd}
              onChange={(e) => setNewEnd(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-wage">New wage (optional)</Label>
            <Input
              id="new-wage"
              type="number"
              inputMode="decimal"
              value={newWage}
              onChange={(e) => setNewWage(e.target.value)}
              placeholder="Leave blank to keep current"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={renew.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={renew.isPending || !newStart}>
            {renew.isPending ? "Renewing…" : "Renew contract"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
