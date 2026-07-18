/**
 * ContractRecordPage — P2 Contracts Workbench detail.
 *
 * Aggregates contract header + lines + release ledger, and surfaces
 * lifecycle transitions (activate / amend / terminate) via P2 RPCs.
 * Utilization is authoritative from `procurement_contracts.utilized_*`
 * columns, maintained by the ceiling trigger.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Pencil,
  XCircle,
} from "lucide-react";

import {
  PageBody,
  PageHeader,
  ActionBar,
  Section,
  StatusBadge,
  LoadingState,
  ErrorState,
  EmptyState,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const STATUS_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  pending_approval: "info",
  active: "success",
  expired: "warning",
  terminated: "danger",
  suspended: "danger",
};

function fmtStatus(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function money(n: number | null | undefined, cur?: string | null) {
  if (n == null) return "—";
  return `${cur ?? ""} ${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm mt-1">{children}</div>
    </div>
  );
}

function utilizationPct(used?: number | null, ceiling?: number | null) {
  const u = Number(used ?? 0);
  const c = Number(ceiling ?? 0);
  if (!c) return null;
  return Math.min(100, (u / c) * 100);
}

export default function ContractRecordPage() {
  const { id } = useParams<{ id: string }>();
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

  if (loading) return <LoadingState />;
  if (error)
    return <ErrorState title="Failed to load contract" description={error} />;
  if (!record)
    return (
      <ErrorState
        title="Contract not found"
        description="This contract does not exist or you don't have access."
      />
    );

  const canActivate =
    record.status === "draft" || record.status === "pending_approval";
  const canAmend = record.status === "active";
  const canTerminate =
    record.status === "active" || record.status === "suspended";

  async function handleActivate() {
    setBusy(true);
    try {
      await activateProcurementContract(record.id);
      toast({ title: "Contract activated" });
      await refresh();
    } catch (e: any) {
      toast({
        title: "Activation failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleAmend() {
    setBusy(true);
    try {
      await amendProcurementContract(record.id, {
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
      toast({
        title: "Amendment failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
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
      await terminateProcurementContract(record.id, termReason);
      toast({ title: "Contract terminated" });
      setTermOpen(false);
      setTermReason("");
      await refresh();
    } catch (e: any) {
      toast({
        title: "Termination failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  const pct = utilizationPct(record.utilized_value, record.ceiling_value);

  return (
    <>
      <PageHeader
        eyebrow={`Contract · ${record.contract_number}`}
        title={record.title}
        description={
          record.supplier?.contact?.name
            ? `Supplier: ${record.supplier.contact.name}`
            : undefined
        }
        actions={
          <ActionBar>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/purchases/contracts")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            {canActivate && (
              <Button size="sm" onClick={handleActivate} disabled={busy}>
                <CheckCircle2 className="mr-2 h-4 w-4" /> Activate
              </Button>
            )}
            {canAmend && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAmendOpen(true)}
                disabled={busy}
              >
                <Pencil className="mr-2 h-4 w-4" /> Amend
              </Button>
            )}
            {canTerminate && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setTermOpen(true)}
                disabled={busy}
              >
                <XCircle className="mr-2 h-4 w-4" /> Terminate
              </Button>
            )}
          </ActionBar>
        }
      />
      <PageBody>
        <Section>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={STATUS_TONE[record.status] ?? "neutral"}>
              {fmtStatus(record.status)}
            </StatusBadge>
            <span className="text-sm text-muted-foreground capitalize">
              {record.kind}
            </span>
            {record.auto_renew && (
              <StatusBadge tone="info">Auto-renew</StatusBadge>
            )}
          </div>
        </Section>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="lines">Lines ({record.lines.length})</TabsTrigger>
            <TabsTrigger value="releases">
              Releases ({record.releases.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            <Section title="Header">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Field label="Contract #">
                  <span className="font-mono">{record.contract_number}</span>
                </Field>
                <Field label="Currency">{record.currency ?? "—"}</Field>
                <Field label="Start">{record.start_date ?? "—"}</Field>
                <Field label="End">{record.end_date ?? "—"}</Field>
                <Field label="Approved at">
                  {record.approved_at
                    ? new Date(record.approved_at).toLocaleString()
                    : "—"}
                </Field>
                <Field label="Terminated at">
                  {record.terminated_at
                    ? new Date(record.terminated_at).toLocaleString()
                    : "—"}
                </Field>
                {record.terminated_reason && (
                  <Field label="Termination reason">
                    {record.terminated_reason}
                  </Field>
                )}
              </div>
            </Section>

            <Section title="Utilization">
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-muted-foreground">
                    Consumed vs ceiling
                  </span>
                  <span className="text-sm">
                    {money(record.utilized_value, record.currency)}
                    <span className="text-muted-foreground"> / </span>
                    {money(record.ceiling_value, record.currency)}
                  </span>
                </div>
                {pct != null ? (
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full ${
                        pct >= 90
                          ? "bg-destructive"
                          : pct >= 70
                            ? "bg-warning"
                            : "bg-primary"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
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
          </TabsContent>

          <TabsContent value="lines" className="mt-4">
            {record.lines.length === 0 ? (
              <EmptyState
                title="No line items"
                description="This contract has no pre-agreed lines — it caps by header value only."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Unit price</TableHead>
                      <TableHead className="text-right">Ceiling qty</TableHead>
                      <TableHead className="text-right">Ceiling value</TableHead>
                      <TableHead className="text-right">Utilized</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.lines.map((l, idx) => {
                      const linePct = utilizationPct(
                        l.utilized_value,
                        l.ceiling_value,
                      );
                      return (
                        <TableRow key={l.id}>
                          <TableCell>{l.sort_order ?? idx + 1}</TableCell>
                          <TableCell>{l.description ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            {money(l.unit_price, record.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            {l.ceiling_quantity ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {money(l.ceiling_value, record.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div>
                              {money(l.utilized_value, record.currency)}
                            </div>
                            {linePct != null && (
                              <div className="mt-1 h-1 w-24 ml-auto rounded-full bg-muted overflow-hidden">
                                <div
                                  className={`h-full ${
                                    linePct >= 90
                                      ? "bg-destructive"
                                      : linePct >= 70
                                        ? "bg-warning"
                                        : "bg-primary"
                                  }`}
                                  style={{ width: `${linePct}%` }}
                                />
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="releases" className="mt-4">
            {record.releases.length === 0 ? (
              <EmptyState
                title="No releases yet"
                description="Releases appear here when POs consume against this contract."
              />
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
                        className={
                          r.purchase_order?.id
                            ? "cursor-pointer hover:bg-muted/40"
                            : ""
                        }
                        onClick={() =>
                          r.purchase_order?.id &&
                          navigate(`/purchases/orders/${r.purchase_order.id}`)
                        }
                      >
                        <TableCell className="text-sm">
                          {new Date(r.released_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {r.purchase_order?.order_number ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.quantity ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(r.value, record.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>

      {/* Amend dialog */}
      <Dialog open={amendOpen} onOpenChange={setAmendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Amend contract</DialogTitle>
            <DialogDescription>
              Leave a field blank to keep its current value.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>New title</Label>
              <Input
                value={amendTitle}
                onChange={(e) => setAmendTitle(e.target.value)}
              />
            </div>
            <div>
              <Label>New end date</Label>
              <Input
                type="date"
                value={amendEnd}
                onChange={(e) => setAmendEnd(e.target.value)}
              />
            </div>
            <div>
              <Label>New ceiling value</Label>
              <Input
                type="number"
                value={amendCeiling}
                onChange={(e) => setAmendCeiling(e.target.value)}
              />
            </div>
            <div>
              <Label>Amendment notes</Label>
              <Textarea
                value={amendNotes}
                onChange={(e) => setAmendNotes(e.target.value)}
                rows={3}
              />
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
              Terminating prevents further PO releases. This action is
              recorded and cannot be undone.
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
            <Button
              variant="destructive"
              onClick={handleTerminate}
              disabled={busy}
            >
              Terminate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
