/**
 * RequisitionRecordPage — P3 Requisitions Workbench detail.
 *
 * Aggregates requisition header + lines + approval trail into a
 * `DocumentRecordView` descriptor rendered through `RecordScaffold`.
 * Lifecycle transitions (submit / approve / reject / cancel) invoke the
 * P3 lifecycle RPCs. Self-action policy is resolved by the central
 * governance engine according to the workspace mode and overrides.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CheckCircle2, Send, XCircle, Ban, FileText, ShoppingCart, PenLine, ExternalLink, Scissors } from "lucide-react";
import { Link } from "react-router-dom";

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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  describeGovernanceError,
  parseGovernanceError,
} from "@/lib/governance/selfActionErrors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRequisitionRecord } from "./useRequisitions";
import { useGovernanceMode } from "@/hooks/governance/useGovernanceMode";
import { useSuppliers } from "../suppliers/useSuppliers";
import {
  approveRequisition,
  amendRequisition,
  cancelRequisition,
  rejectRequisition,
  requisitionClose,
  requisitionCloseLine,
  requisitionConvertToPo,
  requisitionCreateRfq,
  submitRequisition,
} from "./requisitionRpcs";

const DECISION_TONE: Record<string, "success" | "danger" | "neutral" | "info"> = {
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  submitted: "info",
};

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function money(n: number | null | undefined, cur?: string | null) {
  if (n == null) return "—";
  return `${cur ?? ""} ${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();
}

const LINE_COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "qty", header: "Qty", numeric: true, priority: 2, minWidth: 70, compactLabel: "Qty" },
  { id: "unit", header: "Est. unit", numeric: true, priority: 2, minWidth: 100, compactLabel: "@" },
  { id: "total", header: "Est. total", numeric: true, priority: 1, minWidth: 110 },
  { id: "supplier", header: "Suggested supplier", priority: 3, minWidth: 140 },
  { id: "ordered", header: "Ordered", numeric: true, priority: 2, minWidth: 90 },
  { id: "received", header: "Received", numeric: true, priority: 3, minWidth: 90 },
  { id: "cancelled", header: "Short-closed", numeric: true, priority: 3, minWidth: 100 },
  { id: "outstanding", header: "Outstanding", numeric: true, priority: 2, minWidth: 100 },
  { id: "lineStatus", header: "Line status", priority: 2, minWidth: 120 },
  { id: "needBy", header: "Need by", priority: 3, minWidth: 100 },
];

/** Demand still chasing procurement on a line: qty − ordered − short-closed. */
export function lineOutstanding(l: {
  quantity: number | string;
  quantity_ordered?: number | string | null;
  quantity_cancelled?: number | string | null;
}): number {
  return Math.max(
    0,
    Number(l.quantity) - Number(l.quantity_ordered ?? 0) - Number(l.quantity_cancelled ?? 0),
  );
}


const LINE_TONE: Record<string, "success" | "danger" | "neutral" | "info" | "warning"> = {
  open: "neutral",
  sourcing: "info",
  partially_ordered: "warning",
  ordered: "info",
  partially_received: "warning",
  received: "success",
  cancelled: "danger",
  closed: "neutral",
};

export default function RequisitionRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { record, loading, error, refresh } = useRequisitionRecord(id);
  const { mode: governanceMode } = useGovernanceMode();

  const [approveOpen, setApproveOpen] = useState(false);
  const [approveComment, setApproveComment] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [poOpen, setPoOpen] = useState(false);
  const [poSupplierId, setPoSupplierId] = useState<string>("");
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { rows: suppliers } = useSuppliers();

  const canSubmit = record?.status === "draft";
  const canDecide = record?.status === "submitted";
  const isApprovalGated = Boolean(record?.approval_request_id);
  const canCancel = record?.status === "draft" || record?.status === "submitted";
  // Release + amendment windows. The database is authoritative for all of
  // these; the UI only hides actions the server would reject anyway.
  const RELEASABLE = ["approved", "sourcing", "partially_procured"];
  const canRelease = RELEASABLE.includes(record?.status ?? "");
  const canAmend = record?.status === "approved" &&
    (record?.items ?? []).every((i) => Number(i.quantity_ordered ?? 0) === 0);
  // Short-close is only meaningful once demand is live and some of it is
  // still outstanding. `requisition_close` re-validates all of this.
  const openLines = (record?.items ?? []).filter((i) => lineOutstanding(i) > 0);
  const canShortClose =
    RELEASABLE.concat(["procured", "ordered", "partially_fulfilled"]).includes(
      record?.status ?? "",
    ) && openLines.length > 0;


  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok });
      await refresh();
      return true;
    } catch (e: unknown) {
      const governanceError = parseGovernanceError(e);
      const governed = governanceError
        ? describeGovernanceError(governanceError)
        : null;
      toast({
        title: governed?.title ?? "Action failed",
        description:
          governed?.body ??
          (e instanceof Error ? e.message : String(e)),
        variant: "destructive",
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const view = useMemo<DocumentRecordView>(() => {
    if (!record) {
      return {
        kind: "requisition",
        eyebrow: "Requisition",
        listPath: "/purchases/requisitions",
        title: "Requisition",
        loading,
        error,
        notFound: !loading && !error,
      };
    }

    const supplierById = new Map(record.suggested_suppliers.map((s) => [s.id, s]));

    const lineRows: LineItemRow[] = record.items.map((l, idx) => {
      const sup = l.suggested_supplier_id ? supplierById.get(l.suggested_supplier_id) : null;
      return {
        id: l.id,
        cells: [
          { columnId: "description", content: l.description },
          { columnId: "qty", content: l.quantity },
          { columnId: "unit", content: money(l.estimated_unit_price, record.currency) },
          {
            columnId: "total",
            content: money(
              l.estimated_line_total ?? Number(l.quantity) * Number(l.estimated_unit_price),
              record.currency,
            ),
          },
          { columnId: "supplier", content: sup?.contact?.name ?? sup?.supplier_code ?? "—" },
          { columnId: "ordered", content: Number(l.quantity_ordered ?? 0) },
          { columnId: "received", content: Number(l.quantity_received ?? 0) },
          { columnId: "cancelled", content: Number(l.quantity_cancelled ?? 0) },
          { columnId: "outstanding", content: lineOutstanding(l) },
          {
            columnId: "lineStatus",
            content: (
              <StatusBadge tone={LINE_TONE[l.status] ?? "neutral"}>{fmt(l.status)}</StatusBadge>
            ),
          },
          { columnId: "needBy", content: l.need_by_date ?? "—" },
        ],
      };
    });

    return {
      kind: "requisition",
      documentId: record.id,
      eyebrow: `Requisition · ${record.requisition_number}`,
      listPath: "/purchases/requisitions",
      title: record.justification || "Purchase requisition",
      docNumber: record.requisition_number,
      status: record.status,
      meta: (
        <>
          <span>{record.requester?.full_name ?? record.requester?.email ?? "—"}</span>
          <StatusBadge tone="info">Priority: {fmt(record.priority)}</StatusBadge>
          {record.cost_center && <span>Cost centre: {record.cost_center}</span>}
        </>
      ),
      detailFields: [
        { label: "Requisition #", value: <span className="font-mono">{record.requisition_number}</span> },
        { label: "Currency", value: record.currency },
        { label: "Version", value: `v${record.version ?? 1}` },
        { label: "Need by", value: record.need_by_date ?? "—" },
        { label: "Estimated total", value: money(record.estimated_total, record.currency) },
        { label: "Submitted at", value: record.submitted_at ? new Date(record.submitted_at).toLocaleString() : "—" },
        { label: "Approved at", value: record.approved_at ? new Date(record.approved_at).toLocaleString() : "—" },
        { label: "Rejected at", value: record.rejected_at ? new Date(record.rejected_at).toLocaleString() : "—" },
        { label: "Cancelled at", value: record.cancelled_at ? new Date(record.cancelled_at).toLocaleString() : "—" },
      ],
      lineColumns: LINE_COLUMNS,
      lineRows,
      lineEmpty: "This requisition has no lines yet.",
      extraSections: (
        <>
          {record.justification && (
            <Section title="Justification">
              <p className="text-sm whitespace-pre-wrap">{record.justification}</p>
            </Section>
          )}
          {record.rejected_reason && (
            <Section title="Rejection reason">
              <p className="text-sm text-destructive whitespace-pre-wrap">{record.rejected_reason}</p>
            </Section>
          )}
          {record.notes && (
            <Section title="Notes">
              <p className="text-sm whitespace-pre-wrap">{record.notes}</p>
            </Section>
          )}
          <Section title={`Procurement (${record.procurement.length})`}>
            {record.procurement.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing sourced yet. Approved lines can be released to an RFQ or straight
                to a purchase order.
              </p>
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Lines</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.procurement.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-mono text-sm">{d.number}</TableCell>
                        <TableCell className="text-sm">
                          {d.kind === "rfq" ? "RFQ" : "Purchase order"}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone="info">{fmt(d.status)}</StatusBadge>
                        </TableCell>
                        <TableCell className="text-right text-sm">{d.lines}</TableCell>
                        <TableCell className="text-right text-sm">{d.quantity}</TableCell>
                        <TableCell className="text-right">
                          <Button asChild variant="ghost" size="sm">
                            <Link to={d.path}>
                              Open <ExternalLink className="ml-1 h-3 w-3" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
          <Section title={`Approvals (${record.approvals.length})`}>
            {record.approvals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Approvals appear here once the requisition is submitted.
              </p>
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Step</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead>Comment</TableHead>
                      <TableHead>At</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.approvals.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{a.step_order}</TableCell>
                        <TableCell className="text-sm">
                          {a.actor?.full_name ?? a.actor?.email ?? a.actor_user_id}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={DECISION_TONE[a.decision] ?? "neutral"}>
                            {fmt(a.decision)}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{a.comment ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(a.created_at).toLocaleString()}
                        </TableCell>
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
  }, [record, loading, error]);

  // One action vocabulary, same descriptor shape every other document uses.
  const actions: DocumentAction[] = record
    ? [
        {
          /**
           * Context aware: `submit_requisition` reports whether the canonical
           * governance engine actually gated the record. When it did not
           * (solo / no matching rule) there is nobody else to wait for, so we
           * finish the transition in the same click instead of parking it in
           * `submitted` for the same user to approve.
           */
          id: "submit",
          label: governanceMode === "solo" ? "Submit & approve" : "Submit",
          icon: Send,
          group: "core",
          primary: true,
          hidden: !canSubmit,
          disabled: busy,
          onSelect: () =>
            void run(async () => {
              const res = (await submitRequisition(record.id)) as { gated?: boolean } | null;
              if (res && res.gated === false) {
                await approveRequisition(record.id);
              }
            }, "Requisition submitted"),
        },
        {
          id: "approve",
          label: isApprovalGated ? "Review in Approvals" : "Approve",
          icon: isApprovalGated ? ExternalLink : CheckCircle2,
          group: "core",
          primary: true,
          hidden: !canDecide,
          disabled: busy,
          onSelect: () =>
            isApprovalGated
              ? navigate("/settings/workspace?tab=governance")
              : setApproveOpen(true),
        },
        {
          id: "reject",
          label: "Reject",
          icon: XCircle,
          destructive: true,
          hidden: !canDecide || isApprovalGated,
          disabled: busy,
          onSelect: () => setRejectOpen(true),
        },
        {
          id: "create-rfq",
          label: "Source via RFQ",
          icon: FileText,
          group: "core",
          primary: true,
          hidden: !canRelease,
          disabled: busy,
          onSelect: () =>
            void run(
              () => requisitionCreateRfq(record.id),
              "Draft RFQ created from requisition",
            ),
        },
        {
          id: "convert-po",
          label: "Convert to purchase order",
          icon: ShoppingCart,
          group: "core",
          hidden: !canRelease,
          disabled: busy,
          onSelect: () => setPoOpen(true),
        },
        {
          id: "amend",
          label: "Amend (return to draft)",
          icon: PenLine,
          hidden: !canAmend,
          disabled: busy,
          onSelect: () => setAmendOpen(true),
        },
        {
          id: "short-close",
          label: "Short-close outstanding demand",
          icon: Scissors,
          hidden: !canShortClose,
          disabled: busy,
          onSelect: () => setCloseOpen(true),
        },
        {
          id: "cancel",
          label: "Cancel requisition",
          icon: Ban,
          destructive: true,
          hidden: !canCancel,
          disabled: busy,
          onSelect: () => setCancelOpen(true),
        },
      ]
    : [];

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New requisition"
        actions={actions}
      />

      {/* Approve dialog */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve requisition</DialogTitle>
            <DialogDescription>
              Approval follows this workspace’s governance mode and any action-specific policy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Comment (optional)</Label>
              <Textarea value={approveComment} onChange={(e) => setApproveComment(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                const ok = await run(
                  () => approveRequisition(record!.id, approveComment || undefined),
                  "Requisition approved",
                );
                if (ok) {
                  setApproveOpen(false);
                  setApproveComment("");
                }
              }}
            >
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject requisition</DialogTitle>
            <DialogDescription>A reason is required and will be visible to the requester.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason *</Label>
              <Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !rejectReason.trim()}
              onClick={async () => {
                const ok = await run(
                  () => rejectRequisition(record!.id, rejectReason.trim()),
                  "Requisition rejected",
                );
                if (ok) {
                  setRejectOpen(false);
                  setRejectReason("");
                }
              }}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Convert to PO dialog */}
      <Dialog open={poOpen} onOpenChange={setPoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert to purchase order</DialogTitle>
            <DialogDescription>
              Creates a draft purchase order for the unordered approved lines. Use this only
              when the supplier is already decided — otherwise run an RFQ first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Supplier *</Label>
              <Select value={poSupplierId} onValueChange={setPoSupplierId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a supplier" />
                </SelectTrigger>
                <SelectContent>
                  {(suppliers ?? []).map((s: any) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.contact?.name ?? s.supplier_code ?? s.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPoOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !poSupplierId}
              onClick={async () => {
                const ok = await run(
                  () => requisitionConvertToPo(record!.id, poSupplierId),
                  "Draft purchase order created",
                );
                if (ok) {
                  setPoOpen(false);
                  setPoSupplierId("");
                }
              }}
            >
              Create purchase order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Amend dialog */}
      <Dialog open={amendOpen} onOpenChange={setAmendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Amend requisition</DialogTitle>
            <DialogDescription>
              Returns the requisition to draft as a new version and voids the existing
              approval. It must be submitted and approved again before it can be sourced.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason (optional)</Label>
              <Textarea value={amendReason} onChange={(e) => setAmendReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAmendOpen(false)}>
              Keep approved
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                const ok = await run(
                  () => amendRequisition(record!.id, amendReason || undefined),
                  "Requisition returned to draft",
                );
                if (ok) {
                  setAmendOpen(false);
                  setAmendReason("");
                }
              }}
            >
              Amend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel requisition</DialogTitle>
            <DialogDescription>This closes the requisition without generating a PO.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason (optional)</Label>
              <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                const ok = await run(
                  () => cancelRequisition(record!.id, cancelReason || undefined),
                  "Requisition cancelled",
                );
                if (ok) {
                  setCancelOpen(false);
                  setCancelReason("");
                }
              }}
            >
              Cancel requisition
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Short-close dialog — per line, or the whole outstanding balance. */}
      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Short-close outstanding demand</DialogTitle>
            <DialogDescription>
              Cancels the quantity that was never ordered so the requisition stops
              chasing procurement. Quantities already on a purchase order keep their
              own lifecycle and are not affected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason (optional)</Label>
              <Textarea value={closeReason} onChange={(e) => setCloseReason(e.target.value)} rows={2} />
            </div>
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openLines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-sm">{l.description}</TableCell>
                      <TableCell className="text-right text-sm">{lineOutstanding(l)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => requisitionCloseLine(l.id, closeReason || undefined),
                              "Line short-closed",
                            )
                          }
                        >
                          Close line
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCloseOpen(false)}>
              Done
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                const ok = await run(
                  () => requisitionClose(record!.id, closeReason || undefined),
                  "Requisition short-closed",
                );
                if (ok) {
                  setCloseOpen(false);
                  setCloseReason("");
                }
              }}
            >
              Short-close everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>

  );
}
