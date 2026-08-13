/**
 * ContractRecordPage — Contracts Workbench detail.
 *
 * Aggregates contract header + lines + version history + amendments +
 * consumption ledger into a `DocumentRecordView` rendered through
 * `RecordScaffold`, and surfaces the full lifecycle (submit / activate /
 * amend / renew / suspend / resume / terminate / close) via the contract RPCs.
 * Utilization is authoritative from the server-derived committed / received /
 * billed / paid measures.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CheckCircle2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";

import { Section, StatusBadge } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import type {
  DocumentAction,
  DocumentRecordView,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useContractRecord } from "./useContracts";
import type { ContractAmendmentKind } from "./contractRpcs";
import {
  activateProcurementContract,
  amendProcurementContract,
  renewProcurementContract,
  setProcurementContractState,
  submitProcurementContract,
} from "./contractRpcs";

function money(n: number | null | undefined, cur?: string | null) {
  if (n == null) return "—";
  return `${cur ?? ""} ${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();
}

function utilizationPct(used?: number | null, ceiling?: number | null) {
  const u = Number(used ?? 0);
  const c = Number(ceiling ?? 0);
  if (!c) return null;
  return Math.min(100, (u / c) * 100);
}

function UtilizationBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
      <div
        className={`h-full ${pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Measure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

const LEDGER_TONE: Record<string, "success" | "warning" | "info" | "neutral"> = {
  commitment: "info",
  reversal: "warning",
  receipt: "success",
  billing: "neutral",
  payment: "success",
};

const LINE_COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "unit", header: "Agreed price", numeric: true, priority: 2, minWidth: 110, compactLabel: "@" },
  { id: "ceilingQty", header: "Ceiling qty", numeric: true, priority: 3, minWidth: 90, compactLabel: "Qty" },
  { id: "ceilingValue", header: "Ceiling value", numeric: true, priority: 1, minWidth: 110 },
  { id: "committed", header: "Committed", numeric: true, priority: 2, minWidth: 110 },
  { id: "received", header: "Received", numeric: true, priority: 3, minWidth: 110 },
];

const AMENDMENT_KINDS: { value: ContractAmendmentKind; label: string }[] = [
  { value: "extension", label: "Extension" },
  { value: "ceiling_change", label: "Ceiling change" },
  { value: "price_change", label: "Price change" },
  { value: "scope_change", label: "Scope change" },
  { value: "terms_change", label: "Terms change" },
  { value: "other", label: "Other" },
];

export default function ContractRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { record, loading, error, refresh } = useContractRecord(id);

  const [amendOpen, setAmendOpen] = useState(false);
  const [amendKind, setAmendKind] = useState<ContractAmendmentKind>("terms_change");
  const [amendEffective, setAmendEffective] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [amendTitle, setAmendTitle] = useState("");
  const [amendEnd, setAmendEnd] = useState("");
  const [amendCeiling, setAmendCeiling] = useState("");
  const [amendReason, setAmendReason] = useState("");
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewEnd, setRenewEnd] = useState("");
  const [renewCeiling, setRenewCeiling] = useState("");
  const [stateOpen, setStateOpen] = useState<null | "suspend" | "terminate" | "close">(null);
  const [stateReason, setStateReason] = useState("");
  const [busy, setBusy] = useState(false);

  const status = record?.status;
  const canSubmit = status === "draft";
  const canActivate = status === "pending_approval" || status === "suspended" || status === "expired";
  const canAmend = status === "active" || status === "suspended";
  const canRenew = status === "active" || status === "expired";
  const canSuspend = status === "active";
  const canResume = status === "suspended";
  const canTerminate = status === "active" || status === "suspended" || status === "pending_approval";
  const canClose = status === "expired" || status === "terminated";

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast({ title: label });
      await refresh();
      return true;
    } catch (e: any) {
      toast({
        title: `${label} failed`,
        description: e?.message ?? String(e),
        variant: "destructive",
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleAmend() {
    const ok = await run("Contract amended", () =>
      amendProcurementContract(record!.id, {
        kind: amendKind,
        effectiveOn: amendEffective,
        reason: amendReason || null,
        changes: {
          title: amendTitle || null,
          end_date: amendEnd || null,
          ceiling_value: amendCeiling ? Number(amendCeiling) : null,
        },
      }),
    );
    if (ok) {
      setAmendOpen(false);
      setAmendTitle("");
      setAmendEnd("");
      setAmendCeiling("");
      setAmendReason("");
    }
  }

  async function handleRenew() {
    if (!renewEnd) {
      toast({ title: "New end date required", variant: "destructive" });
      return;
    }
    const ok = await run("Contract renewed", () =>
      renewProcurementContract(
        record!.id,
        renewEnd,
        renewCeiling ? Number(renewCeiling) : null,
      ),
    );
    if (ok) {
      setRenewOpen(false);
      setRenewEnd("");
      setRenewCeiling("");
    }
  }

  async function handleStateChange() {
    const action = stateOpen!;
    if (action !== "close" && !stateReason.trim()) {
      toast({ title: "Reason required", variant: "destructive" });
      return;
    }
    const ok = await run(
      action === "suspend" ? "Contract suspended" : action === "close" ? "Contract closed" : "Contract terminated",
      () => setProcurementContractState(record!.id, action, stateReason || null),
    );
    if (ok) {
      setStateOpen(null);
      setStateReason("");
    }
  }

  const view = useMemo<DocumentRecordView>(() => {
    if (!record) {
      return {
        kind: "contract",
        eyebrow: "Contract",
        listPath: "/purchases/contracts",
        title: "Contract",
        loading,
        error,
        notFound: !loading && !error,
      };
    }

    const pct = utilizationPct(record.committed_value, record.ceiling_value);
    const remaining =
      record.ceiling_value == null
        ? null
        : Number(record.ceiling_value) - Number(record.committed_value ?? 0);

    const lineRows: LineItemRow[] = record.lines.map((l) => {
      const linePct = utilizationPct(l.committed_value, l.ceiling_value);
      return {
        id: l.id,
        cells: [
          { columnId: "description", content: l.description ?? "—" },
          { columnId: "unit", content: money(l.unit_price, record.currency) },
          { columnId: "ceilingQty", content: l.ceiling_quantity ?? "—" },
          { columnId: "ceilingValue", content: money(l.ceiling_value, record.currency) },
          {
            columnId: "committed",
            content: (
              <div>
                <div>{money(l.committed_value, record.currency)}</div>
                {linePct != null && (
                  <div className="mt-1 h-1 w-24 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full ${linePct >= 90 ? "bg-destructive" : linePct >= 70 ? "bg-warning" : "bg-primary"}`}
                      style={{ width: `${linePct}%` }}
                    />
                  </div>
                )}
              </div>
            ),
          },
          { columnId: "received", content: money(l.received_value, record.currency) },
        ],
      };
    });

    return {
      kind: "contract",
      documentId: record.id,
      eyebrow: `Contract · ${record.contract_number}`,
      listPath: "/purchases/contracts",
      title: record.title,
      docNumber: record.contract_number,
      status: record.status,
      meta: (
        <>
          {record.supplier?.contact?.name && <span>Supplier: {record.supplier.contact.name}</span>}
          <span className="capitalize">{String(record.kind).replace("_", " ")}</span>
          <span>v{record.current_version ?? 1}</span>
          {record.auto_renew && <StatusBadge tone="info">Auto-renew</StatusBadge>}
        </>
      ),
      detailFields: [
        { label: "Contract #", value: <span className="font-mono">{record.contract_number}</span> },
        {
          label: "Currency",
          value:
            record.currency && record.base_currency && record.currency !== record.base_currency
              ? `${record.currency} @ ${record.exchange_rate ?? "—"} → ${record.base_currency}`
              : (record.currency ?? "—"),
        },
        { label: "Start", value: record.start_date ?? "—" },
        { label: "End", value: record.end_date ?? "—" },
        {
          label: "Price tolerance",
          value: `${Number(record.price_tolerance_percent ?? 0)}%${
            Number(record.price_tolerance_amount ?? 0) > 0
              ? ` / ${money(record.price_tolerance_amount, record.currency)}`
              : ""
          }`,
        },
        {
          label: "Item coverage",
          value: record.enforce_item_coverage ? "Contract items only" : "Open catalogue",
        },
        { label: "Submitted at", value: record.submitted_at ? new Date(record.submitted_at).toLocaleString() : "—" },
        { label: "Approved at", value: record.approved_at ? new Date(record.approved_at).toLocaleString() : "—" },
        ...(record.suspension_reason
          ? [{ label: "Suspension reason", value: record.suspension_reason }]
          : []),
        ...(record.terminated_reason
          ? [{ label: "Termination reason", value: record.terminated_reason }]
          : []),
      ],
      lineColumns: LINE_COLUMNS,
      lineRows,
      lineEmpty: "This contract has no pre-agreed lines — it caps by header value only.",
      extraSections: (
        <>
          <Section title="Utilization">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Measure
                  label="Committed"
                  value={money(record.committed_value, record.currency)}
                  hint="Approved POs, net of reversals"
                />
                <Measure label="Received" value={money(record.received_value, record.currency)} hint="Goods receipted" />
                <Measure label="Billed" value={money(record.billed_value, record.currency)} hint="Supplier bills" />
                <Measure label="Paid" value={money(record.paid_value, record.currency)} hint="Settled" />
                <Measure
                  label="Remaining"
                  value={remaining == null ? "No ceiling" : money(remaining, record.currency)}
                  hint="Ceiling less committed"
                />
              </div>
              {pct != null ? (
                <UtilizationBar pct={pct} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  No ceiling set — utilization not capped at header level.
                </p>
              )}
            </div>
          </Section>

          {record.notes && (
            <Section title="Notes">
              <p className="text-sm whitespace-pre-wrap">{record.notes}</p>
            </Section>
          )}

          <Section title={`Consumption ledger (${record.releases.length})`}>
            {record.releases.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Entries appear here as POs commit and receipts, bills and payments land.
              </p>
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Posted</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Purchase order</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.releases.map((r) => (
                      <TableRow
                        key={r.id}
                        className={r.purchase_order?.id ? "cursor-pointer hover:bg-muted/40" : ""}
                        onClick={() =>
                          r.purchase_order?.id && navigate(`/purchases/orders/${r.purchase_order.id}`)
                        }
                      >
                        <TableCell className="text-sm">{new Date(r.released_at).toLocaleString()}</TableCell>
                        <TableCell>
                          <StatusBadge tone={LEDGER_TONE[r.entry_kind] ?? "neutral"}>
                            {String(r.entry_kind)}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {r.purchase_order?.order_number ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.quantity ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(r.value, record.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>

          <Section title={`Amendments (${record.amendments.length})`}>
            {record.amendments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No amendments — the contract is still on its original terms (v
                {record.current_version ?? 1}).
              </p>
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Effective</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.amendments.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="tabular-nums">{a.amendment_number}</TableCell>
                        <TableCell className="capitalize">{a.kind.replace("_", " ")}</TableCell>
                        <TableCell>{a.effective_on}</TableCell>
                        <TableCell className="tabular-nums">
                          v{a.from_version} → v{a.to_version}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{a.reason ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>

          <Section title={`Version history (${record.versions.length})`}>
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Effective from</TableHead>
                    <TableHead>Effective to</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {record.versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="tabular-nums">v{v.version_number}</TableCell>
                      <TableCell>{v.effective_from}</TableCell>
                      <TableCell>{v.effective_to ?? "Current"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Array.isArray(v.lines_snapshot) ? v.lines_snapshot.length : 0}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        </>
      ),
    };
  }, [record, loading, error, navigate]);

  const actions = useMemo<DocumentAction[]>(
    () => [
      {
        id: "submit",
        label: "Submit for approval",
        icon: Send,
        primary: true,
        hidden: !canSubmit,
        disabled: busy,
        onSelect: () => void run("Submitted for approval", () => submitProcurementContract(record!.id)),
      },
      {
        id: "activate",
        label: status === "suspended" ? "Reinstate" : "Approve & activate",
        icon: CheckCircle2,
        primary: true,
        hidden: !canActivate,
        disabled: busy,
        onSelect: () => void run("Contract activated", () => activateProcurementContract(record!.id)),
      },
      {
        id: "amend",
        label: "Amend",
        icon: Pencil,
        primary: true,
        hidden: !canAmend,
        disabled: busy,
        onSelect: () => setAmendOpen(true),
      },
      {
        id: "renew",
        label: "Renew",
        icon: RefreshCw,
        hidden: !canRenew,
        disabled: busy,
        onSelect: () => setRenewOpen(true),
      },
      {
        id: "suspend",
        label: "Suspend",
        icon: Pause,
        hidden: !canSuspend,
        disabled: busy,
        onSelect: () => setStateOpen("suspend"),
      },
      {
        id: "resume",
        label: "Resume",
        icon: Play,
        hidden: !canResume,
        disabled: busy,
        onSelect: () => void run("Contract resumed", () => setProcurementContractState(record!.id, "resume")),
      },
      {
        id: "close",
        label: "Close",
        icon: XCircle,
        hidden: !canClose,
        disabled: busy,
        onSelect: () => setStateOpen("close"),
      },
      {
        id: "terminate",
        label: "Terminate",
        icon: XCircle,
        destructive: true,
        hidden: !canTerminate,
        disabled: busy,
        onSelect: () => setStateOpen("terminate"),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canSubmit, canActivate, canAmend, canRenew, canSuspend, canResume, canClose, canTerminate, busy, status, record?.id],
  );

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New contract"
        actions={record ? actions : undefined}
      />

      {/* Amend dialog */}
      <Dialog open={amendOpen} onOpenChange={setAmendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Amend contract</DialogTitle>
            <DialogDescription>
              Creates a new contract version effective from the date you choose. Leave a field blank
              to keep its current value.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Amendment type</Label>
              <Select value={amendKind} onValueChange={(v) => setAmendKind(v as ContractAmendmentKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AMENDMENT_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Effective on *</Label>
              <Input
                type="date"
                value={amendEffective}
                onChange={(e) => setAmendEffective(e.target.value)}
              />
            </div>
            <div>
              <Label>New title</Label>
              <Input value={amendTitle} onChange={(e) => setAmendTitle(e.target.value)} />
            </div>
            <div>
              <Label>New end date</Label>
              <Input type="date" value={amendEnd} onChange={(e) => setAmendEnd(e.target.value)} />
            </div>
            <div>
              <Label>New ceiling value</Label>
              <Input
                type="number"
                value={amendCeiling}
                onChange={(e) => setAmendCeiling(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Cannot be lowered below the value already committed.
              </p>
            </div>
            <div>
              <Label>Reason</Label>
              <Textarea value={amendReason} onChange={(e) => setAmendReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAmendOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAmend} disabled={busy}>
              Save amendment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Renew dialog */}
      <Dialog open={renewOpen} onOpenChange={setRenewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renew contract</DialogTitle>
            <DialogDescription>
              Records a renewal amendment and extends the term.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>New end date *</Label>
              <Input type="date" value={renewEnd} onChange={(e) => setRenewEnd(e.target.value)} />
            </div>
            <div>
              <Label>New ceiling value</Label>
              <Input
                type="number"
                value={renewCeiling}
                onChange={(e) => setRenewCeiling(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenewOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRenew} disabled={busy}>
              Renew
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* State change dialog */}
      <Dialog open={stateOpen !== null} onOpenChange={(o) => !o && setStateOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {stateOpen === "suspend"
                ? "Suspend contract"
                : stateOpen === "close"
                  ? "Close contract"
                  : "Terminate contract"}
            </DialogTitle>
            <DialogDescription>
              {stateOpen === "suspend"
                ? "Suspending blocks new PO releases until the contract is resumed."
                : stateOpen === "close"
                  ? "Closing archives the contract. No further activity is possible."
                  : "Terminating permanently prevents further PO releases. This is recorded and cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label>{stateOpen === "close" ? "Note" : "Reason *"}</Label>
            <Textarea
              value={stateReason}
              onChange={(e) => setStateReason(e.target.value)}
              rows={4}
              placeholder="Explain why"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStateOpen(null)}>
              Cancel
            </Button>
            <Button
              variant={stateOpen === "terminate" ? "destructive" : "default"}
              onClick={handleStateChange}
              disabled={busy}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
