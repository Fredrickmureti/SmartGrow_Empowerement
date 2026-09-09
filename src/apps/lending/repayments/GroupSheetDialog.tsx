/**
 * Group collection sheet (M4).
 *
 * One meeting, one submission: the officer enters what each member paid and
 * every non-zero line is posted as its own receipt through
 * `mf_record_repayment`, inside a single batch for the meeting. There is no
 * pooled group balance — each member's money allocates against their own loan
 * by the configured allocation order, server-side.
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
  BranchDayDateField,
  useBranchDayGate,
} from "@/components/lending/BranchDayDateField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingState, ErrorState, StatusBadge } from "@/design-system";
import { useMfGroups } from "@/hooks/useMfGroups";
import { useMfGroupSheet } from "@/hooks/useMfGroupSheet";
import { MF_REPAYMENT_METHODS } from "@/hooks/useMfRepayments";

const money = (value: number, currency = "") =>
  `${currency} ${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When collecting from inside a meeting, the group is fixed. */
  lockedGroupId?: string | null;
  /** Stamps the batch with the meeting this money was collected at. */
  meetingId?: string | null;
  /** Default collection date (the meeting date when launched from a meeting). */
  defaultDate?: string;
  /** Opens the meeting batch and returns its id. */
  onOpenBatch: (input: {
    collectedOn: string;
    groupId: string;
    branchId: string | null;
    notes: string | null;
    meetingId?: string | null;
  }) => Promise<string>;
  /** Posts one member's payment; the server allocates it. */
  onRecord: (input: {
    loanId: string;
    paidOn: string;
    amount: number;
    method: string;
    reference: string | null;
    batchId: string | null;
    notes: string | null;
  }) => Promise<unknown>;
  onPosted?: (batchId: string) => void;
}

export function GroupSheetDialog({
  open,
  onOpenChange,
  lockedGroupId,
  meetingId,
  defaultDate,
  onOpenBatch,
  onRecord,
  onPosted,
}: Props) {
  const { groups } = useMfGroups();
  const [groupId, setGroupId] = useState("");
  const [collectedOn, setCollectedOn] = useState("");
  const [method, setMethod] = useState("cash");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const dayGate = useBranchDayGate();
  const [failures, setFailures] = useState<string[]>([]);

  const { rows, isLoading, error } = useMfGroupSheet(open ? groupId || null : null);
  const group = groups.find((g) => g.id === groupId) ?? null;

  useEffect(() => {
    if (!open) return;
    setGroupId(lockedGroupId ?? "");
    setCollectedOn(defaultDate ?? new Date().toISOString().slice(0, 10));
    setMethod("cash");
    setAmounts({});
    setFailures([]);
  }, [open, lockedGroupId, defaultDate]);

  // Pre-fill each line with the contractual amount due now, arrears first.
  useEffect(() => {
    if (rows.length === 0) {
      // Skip the update when already empty so a no-op doesn't retrigger the loop.
      setAmounts((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    setAmounts(
      Object.fromEntries(
        rows.map((r) => {
          const due = r.amountOverdue > 0 ? r.amountOverdue : r.installmentDue;
          return [r.loanId, due > 0 ? String(due) : ""];
        }),
      ),
    );
  }, [rows]);

  const lines = useMemo(
    () =>
      rows
        .map((r) => ({ row: r, amount: Number(amounts[r.loanId] ?? 0) }))
        .filter((l) => Number.isFinite(l.amount) && l.amount > 0),
    [rows, amounts],
  );
  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  const currency = rows[0]?.currencyCode ?? "";

  const submit = async () => {
    if (!groupId || lines.length === 0) return;
    setSaving(true);
    setFailures([]);
    try {
      const batchId = await onOpenBatch({
        collectedOn,
        groupId,
        branchId: group?.branch_id ?? null,
        notes: group ? `Group meeting — ${group.name}` : null,
        meetingId: meetingId ?? null,
      });
      const failed: string[] = [];
      for (const line of lines) {
        try {
          await onRecord({
            loanId: line.row.loanId,
            paidOn: collectedOn,
            amount: line.amount,
            method,
            reference: null,
            batchId,
            notes: `Group sheet — ${group?.group_number ?? ""} ${line.row.clientNumber}`.trim(),
          });
        } catch {
          failed.push(`${line.row.clientName} (${line.row.loanNumber})`);
        }
      }
      setFailures(failed);
      onPosted?.(batchId);
      if (failed.length === 0) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Group collection sheet</DialogTitle>
          <DialogDescription>
            Enter what each member paid at the meeting. Each line posts as its own
            receipt and allocates against that member&apos;s own loan.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Group</Label>
            <Select
              value={groupId}
              onValueChange={setGroupId}
              disabled={!!lockedGroupId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select group" />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.group_number} — {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <BranchDayDateField
            label="Meeting date"
            value={collectedOn}
            onChange={setCollectedOn}
          />
          <div className="space-y-1.5">
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

        <div className="max-h-[45vh] overflow-y-auto">
          {!groupId ? (
            <EmptyState
              title="Select a group"
              description="Pick the group whose meeting you are collecting at."
            />
          ) : error ? (
            <ErrorState description={error.message} />
          ) : isLoading ? (
            <LoadingState />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No active loans in this group"
              description="Members with no active loan cannot be collected from."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Loan</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead className="text-right">Due now</TableHead>
                  <TableHead className="text-right">Arrears</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.loanId}>
                    <TableCell>
                      <div className="font-medium">{r.clientName}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.clientNumber}
                        {r.roleInGroup && r.roleInGroup !== "member"
                          ? ` · ${r.roleInGroup}`
                          : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{r.loanNumber}</TableCell>
                    <TableCell className="text-sm">
                      {r.dueDate ?? "—"}
                      {r.installmentNo ? (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          · #{r.installmentNo}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {money(r.installmentDue, r.currencyCode)}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {r.amountOverdue > 0 ? (
                        <StatusBadge tone="danger">
                          {money(r.amountOverdue, r.currencyCode)} · {r.daysPastDue}d
                        </StatusBadge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        className="ml-auto h-8 w-32 text-right"
                        inputMode="decimal"
                        value={amounts[r.loanId] ?? ""}
                        onChange={(e) =>
                          setAmounts((prev) => ({ ...prev, [r.loanId]: e.target.value }))
                        }
                        placeholder="0.00"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {failures.length > 0 && (
          <p className="text-sm text-destructive">
            Not posted: {failures.join(", ")}. The other receipts were posted.
          </p>
        )}

        <DialogFooter className="items-center justify-between gap-3 sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {lines.length} line(s) · total{" "}
            <span className="font-medium text-foreground">{money(total, currency)}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={saving || lines.length === 0 || dayGate.blocked}
            >
              {saving ? "Posting…" : "Post collection sheet"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
