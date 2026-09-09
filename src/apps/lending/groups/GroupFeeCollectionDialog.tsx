/**
 * Group → Collect admission fees.
 *
 * The admission fee is always the individual client's obligation. This screen
 * is only the collection context: it lists each active member with the fee due,
 * what has been paid and what is still outstanding (read from the authoritative
 * server view, never a flag), lets the operator tick members and adjust the
 * amount, and submits one collection the server validates, allocates and posts.
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
import { Checkbox } from "@/components/ui/checkbox";
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
import { EmptyState, LoadingState, StatusBadge, Section } from "@/design-system";
import { LendingDocumentsMenu } from "@/apps/lending/documents/LendingDocumentsMenu";
import { MF_REPAYMENT_METHODS } from "@/hooks/useMfRepayments";
import type { MfGroup } from "@/hooks/useMfGroups";
import {
  makeFeeCollectionRequestId,
  useMfFeeCollections,
  useMfGroupFeePositions,
  type MfFeeCollectionLine,
} from "@/hooks/useMfFeeCollections";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: MfGroup | null;
  canCollect: boolean;
}

const money = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function GroupFeeCollectionDialog({ open, onOpenChange, group, canCollect }: Props) {
  const groupId = open && group ? group.id : null;
  const { data: positions = [], isLoading } = useMfGroupFeePositions(groupId);
  const { collections, allocations, collect, reverse } = useMfFeeCollections(groupId);

  const [collectedOn, setCollectedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const outstandingMembers = useMemo(
    () => positions.filter((p) => Number(p.outstanding_amount) > 0),
    [positions],
  );

  useEffect(() => {
    if (!open) return;
    const nextSel: Record<string, boolean> = {};
    const nextAmt: Record<string, string> = {};
    for (const p of positions) {
      const out = Number(p.outstanding_amount);
      if (out > 0) {
        nextSel[p.client_id] = true;
        nextAmt[p.client_id] = out.toFixed(2);
      }
    }
    setSelected(nextSel);
    setAmounts(nextAmt);
  }, [open, positions]);

  const lines: MfFeeCollectionLine[] = useMemo(
    () =>
      outstandingMembers
        .filter((p) => selected[p.client_id])
        .map((p) => ({
          client_id: p.client_id,
          amount: Math.round((Number(amounts[p.client_id] ?? 0) || 0) * 100) / 100,
        }))
        .filter((l) => l.amount > 0),
    [outstandingMembers, selected, amounts],
  );

  const total = lines.reduce((s, l) => s + l.amount, 0);
  const groupOutstanding = positions.reduce((s, p) => s + Number(p.outstanding_amount), 0);

  const overAny = outstandingMembers.some(
    (p) =>
      selected[p.client_id] &&
      (Number(amounts[p.client_id] ?? 0) || 0) > Number(p.outstanding_amount) + 0.001,
  );

  const submit = async () => {
    if (!group || lines.length === 0 || overAny) return;
    const ref = reference.trim() || null;
    await collect.mutateAsync({
      collectedOn,
      method,
      reference: ref,
      notes: notes.trim() || null,
      lines,
      requestId: makeFeeCollectionRequestId(group.id, collectedOn, method, ref, lines),
    });
    setReference("");
    setNotes("");
  };

  const allocationsFor = (collectionId: string) =>
    allocations.filter((a) => a.collection_id === collectionId);

  const nameOf = (clientId: string) =>
    positions.find((p) => p.client_id === clientId)?.full_name ?? clientId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {group ? `${group.name} — admission fees` : "Admission fees"}
          </DialogTitle>
          <DialogDescription>
            Each member owes their own admission fee. Collecting together is only
            a convenience — every shilling is still allocated to a named member.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LoadingState />
        ) : positions.length === 0 ? (
          <EmptyState
            title="No members"
            description="Add members to this group before collecting fees."
          />
        ) : (
          <>
            <Section
              title="Members"
              description={`Group outstanding ${money(groupOutstanding)}`}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Member</TableHead>
                    <TableHead className="text-right">Fee due</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="text-right">Collect now</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((p) => {
                    const out = Number(p.outstanding_amount);
                    const settled = out <= 0;
                    return (
                      <TableRow key={p.client_id}>
                        <TableCell>
                          <Checkbox
                            checked={!!selected[p.client_id]}
                            disabled={settled || !canCollect}
                            onCheckedChange={(v) =>
                              setSelected((s) => ({ ...s, [p.client_id]: !!v }))
                            }
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          {p.client_number} — {p.full_name}
                          {p.charge_status === "none" ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              no fee raised yet
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">{money(Number(p.fee_amount))}</TableCell>
                        <TableCell className="text-right">{money(Number(p.paid_amount))}</TableCell>
                        <TableCell className="text-right">{money(out)}</TableCell>
                        <TableCell className="text-right">
                          {settled ? (
                            <StatusBadge tone="success">settled</StatusBadge>
                          ) : (
                            <Input
                              className="ml-auto h-8 w-28 text-right"
                              inputMode="decimal"
                              disabled={!selected[p.client_id] || !canCollect}
                              value={amounts[p.client_id] ?? ""}
                              onChange={(e) =>
                                setAmounts((a) => ({ ...a, [p.client_id]: e.target.value }))
                              }
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Section>

            {canCollect ? (
              <Section title="Collection">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div>
                    <Label className="text-xs">Date</Label>
                    <Input
                      type="date"
                      value={collectedOn}
                      onChange={(e) => setCollectedOn(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Method</Label>
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
                  <div>
                    <Label className="text-xs">Reference</Label>
                    <Input
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      placeholder="Optional"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Note</Label>
                    <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </div>
                </div>
                <p className="mt-3 text-sm">
                  Collecting <strong>{money(total)}</strong> from {lines.length} member(s).
                  {overAny ? (
                    <span className="ml-2 text-destructive">
                      An amount is higher than that member&apos;s outstanding fee.
                    </span>
                  ) : null}
                </p>
              </Section>
            ) : null}

            {collections.length > 0 ? (
              <Section title="Collection history">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Number</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Members settled</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {collections.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono text-xs">{c.collection_number}</TableCell>
                        <TableCell>{c.collected_on}</TableCell>
                        <TableCell className="text-xs">
                          {allocationsFor(c.id)
                            .map((a) => `${nameOf(a.client_id)} ${money(Number(a.amount))}`)
                            .join(", ") || "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(Number(c.total_amount))}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={c.status === "reversed" ? "danger" : "success"}>
                            {c.status}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <LendingDocumentsMenu
                              label="Receipt"
                              documents={[
                                {
                                  documentType: "fee_collection_receipt",
                                  documentId: c.id,
                                  title: "Group fee collection receipt",
                                  filename: `fee-collection-${c.collection_number}`,
                                },
                              ]}
                            />
                            {c.status === "posted" && canCollect ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={reverse.isPending}
                                onClick={() =>
                                  reverse.mutate({
                                    collectionId: c.id,
                                    reason: "Reversed from group collection history",
                                  })
                                }
                              >
                                Reverse
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {canCollect ? (
            <Button
              onClick={submit}
              disabled={lines.length === 0 || overAny || collect.isPending}
            >
              {collect.isPending ? "Recording…" : `Record ${money(total)}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GroupFeeCollectionDialog;
