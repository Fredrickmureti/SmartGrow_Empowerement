/**
 * ContractRecordPage — P2 Contracts Workbench detail.
 *
 * Aggregates contract header + lines + release ledger into a
 * `DocumentRecordView` descriptor rendered through `RecordScaffold`, and
 * surfaces lifecycle transitions (activate / amend / terminate) via P2
 * RPCs. Utilization is authoritative from
 * `procurement_contracts.utilized_*` columns, maintained by the ceiling
 * trigger.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CheckCircle2, Pencil, XCircle } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useContractRecord } from "./useContracts";
import {
  activateProcurementContract,
  amendProcurementContract,
  terminateProcurementContract,
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

const LINE_COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "unit", header: "Unit price", numeric: true, priority: 2, minWidth: 100, compactLabel: "@" },
  { id: "ceilingQty", header: "Ceiling qty", numeric: true, priority: 3, minWidth: 90, compactLabel: "Qty" },
  { id: "ceilingValue", header: "Ceiling value", numeric: true, priority: 1, minWidth: 110 },
  { id: "utilized", header: "Utilized", numeric: true, priority: 2, minWidth: 110 },
];

export default function ContractRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { record, loading, error, refresh } = useContractRecord(id);

  const [amendOpen, setAmendOpen] = useState(false);
  const [amendTitle, setAmendTitle] = useState("");
  const [amendEnd, setAmendEnd] = useState("");
  const [amendCeiling, setAmendCeiling] = useState("");
  const [amendNotes, setAmendNotes] = useState("");
  const [termOpen, setTermOpen] = useState(false);
  const [termReason, setTermReason] = useState("");
  const [busy, setBusy] = useState(false);

  const canActivate = record?.status === "draft" || record?.status === "pending_approval";
  const canAmend = record?.status === "active";
  const canTerminate = record?.status === "active" || record?.status === "suspended";

  async function handleActivate() {
    setBusy(true);
    try {
      await activateProcurementContract(record!.id);
      toast({ title: "Contract activated" });
      await refresh();
    } catch (e: any) {
      toast({ title: "Activation failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function handleAmend() {
    setBusy(true);
    try {
      await amendProcurementContract(record!.id, {
        title: amendTitle || null,
        endDate: amendEnd || null,
        ceilingValue: amendCeiling ? Number(amendCeiling) : null,
        notes: amendNotes || null,
      });
      toast({ title: "Contract amended" });
      setAmendOpen(false);
      setAmendTitle("");
      setAmendEnd("");
      setAmendCeiling("");
      setAmendNotes("");
      await refresh();
    } catch (e: any) {
      toast({ title: "Amendment failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function handleTerminate() {
    if (!termReason.trim()) {
      toast({ title: "Reason required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await terminateProcurementContract(record!.id, termReason);
      toast({ title: "Contract terminated" });
      setTermOpen(false);
      setTermReason("");
      await refresh();
    } catch (e: any) {
      toast({ title: "Termination failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setBusy(false);
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

    const pct = utilizationPct(record.utilized_value, record.ceiling_value);

    const lineRows: LineItemRow[] = record.lines.map((l, idx) => {
      const linePct = utilizationPct(l.utilized_value, l.ceiling_value);
      return {
        id: l.id,
        cells: [
          { columnId: "description", content: l.description ?? "—" },
          { columnId: "unit", content: money(l.unit_price, record.currency) },
          { columnId: "ceilingQty", content: l.ceiling_quantity ?? "—" },
          { columnId: "ceilingValue", content: money(l.ceiling_value, record.currency) },
          {
            columnId: "utilized",
            content: (
              <div>
                <div>{money(l.utilized_value, record.currency)}</div>
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
          <span className="capitalize">{record.kind}</span>
          {record.auto_renew && <StatusBadge tone="info">Auto-renew</StatusBadge>}
        </>
      ),
      detailFields: [
        { label: "Contract #", value: <span className="font-mono">{record.contract_number}</span> },
        { label: "Currency", value: record.currency ?? "—" },
        { label: "Start", value: record.start_date ?? "—" },
        { label: "End", value: record.end_date ?? "—" },
        { label: "Approved at", value: record.approved_at ? new Date(record.approved_at).toLocaleString() : "—" },
        { label: "Terminated at", value: record.terminated_at ? new Date(record.terminated_at).toLocaleString() : "—" },
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
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Consumed vs ceiling</span>
                <span className="text-sm">
                  {money(record.utilized_value, record.currency)}
                  <span className="text-muted-foreground"> / </span>
                  {money(record.ceiling_value, record.currency)}
                </span>
              </div>
              {pct != null ? (
                <UtilizationBar pct={pct} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  No ceiling set — utilization not tracked at header level.
                </p>
              )}
            </div>
          </Section>

          {record.notes && (
            <Section title="Notes">
              <p className="text-sm whitespace-pre-wrap">{record.notes}</p>
            </Section>
          )}

          <Section title={`Releases (${record.releases.length})`}>
            {record.releases.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Releases appear here when POs consume against this contract.
              </p>
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Released</TableHead>
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
                        <TableCell className="font-mono text-sm">
                          {r.purchase_order?.order_number ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">{r.quantity ?? "—"}</TableCell>
                        <TableCell className="text-right">{money(r.value, record.currency)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
        </>
      ),
    };
  }, [record, loading, error, navigate]);

  // One action vocabulary — same descriptor the Contracts list row menu uses.
  const actions = useMemo<DocumentAction[]>(
    () => [
      {
        id: "activate",
        label: "Activate",
        icon: CheckCircle2,
        primary: true,
        hidden: !canActivate,
        disabled: busy,
        onSelect: () => void handleActivate(),
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
        id: "terminate",
        label: "Terminate",
        icon: XCircle,
        destructive: true,
        hidden: !canTerminate,
        disabled: busy,
        onSelect: () => setTermOpen(true),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canActivate, canAmend, canTerminate, busy],
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
            <DialogDescription>Leave a field blank to keep its current value.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
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
              <Input type="number" value={amendCeiling} onChange={(e) => setAmendCeiling(e.target.value)} />
            </div>
            <div>
              <Label>Amendment notes</Label>
              <Textarea value={amendNotes} onChange={(e) => setAmendNotes(e.target.value)} rows={3} />
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

      {/* Terminate dialog */}
      <Dialog open={termOpen} onOpenChange={setTermOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate contract</DialogTitle>
            <DialogDescription>
              Terminating prevents further PO releases. This action is recorded and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label>Reason *</Label>
            <Textarea
              value={termReason}
              onChange={(e) => setTermReason(e.target.value)}
              rows={4}
              placeholder="Why is this contract being terminated?"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTermOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleTerminate} disabled={busy}>
              Terminate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
