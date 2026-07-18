/**
 * RequisitionRecordPage — P3 Requisitions Workbench detail.
 *
 * Aggregates requisition header + lines + approval trail. Lifecycle
 * transitions (submit / approve / reject / cancel) invoke the P3
 * lifecycle RPCs. Self-approval is blocked both in the database
 * (`approve_requisition`) and mirrored by the SoD registry rows.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Send,
  XCircle,
  Ban,
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useRequisitionRecord } from "./useRequisitions";
import {
  approveRequisition,
  cancelRequisition,
  rejectRequisition,
  submitRequisition,
} from "./requisitionRpcs";

const STATUS_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  rejected: "danger",
  cancelled: "warning",
  closed: "neutral",
};

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm mt-1">{children}</div>
    </div>
  );
}

export default function RequisitionRecordPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { record, loading, error, refresh } = useRequisitionRecord(id);

  const [approveOpen, setApproveOpen] = useState(false);
  const [approveComment, setApproveComment] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) return <LoadingState />;
  if (error)
    return <ErrorState title="Failed to load requisition" description={error} />;
  if (!record)
    return (
      <ErrorState
        title="Requisition not found"
        description="This requisition does not exist or you don't have access."
      />
    );

  const canSubmit = record.status === "draft";
  const canDecide = record.status === "submitted";
  const canCancel = record.status === "draft" || record.status === "submitted";

  const supplierById = new Map(
    record.suggested_suppliers.map((s) => [s.id, s]),
  );

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok });
      await refresh();
      return true;
    } catch (e: any) {
      toast({
        title: "Action failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`Requisition · ${record.requisition_number}`}
        title={record.justification || "Purchase requisition"}
        description={
          record.requester?.full_name
            ? `Requester: ${record.requester.full_name}`
            : record.requester?.email ?? undefined
        }
        actions={
          <ActionBar>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/purchases/requisitions")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            {canSubmit && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(() => submitRequisition(record.id), "Requisition submitted")
                }
              >
                <Send className="mr-2 h-4 w-4" /> Submit
              </Button>
            )}
            {canDecide && (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => setApproveOpen(true)}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" /> Approve
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRejectOpen(true)}
                >
                  <XCircle className="mr-2 h-4 w-4" /> Reject
                </Button>
              </>
            )}
            {canCancel && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCancelOpen(true)}
              >
                <Ban className="mr-2 h-4 w-4" /> Cancel
              </Button>
            )}
          </ActionBar>
        }
      />
      <PageBody>
        <Section>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={STATUS_TONE[record.status] ?? "neutral"}>
              {fmt(record.status)}
            </StatusBadge>
            <StatusBadge tone="info">Priority: {fmt(record.priority)}</StatusBadge>
            {record.cost_center && (
              <span className="text-sm text-muted-foreground">
                Cost centre: <span className="font-medium">{record.cost_center}</span>
              </span>
            )}
          </div>
        </Section>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="lines">Lines ({record.items.length})</TabsTrigger>
            <TabsTrigger value="approvals">
              Approvals ({record.approvals.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            <Section title="Header">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Field label="Requisition #">
                  <span className="font-mono">{record.requisition_number}</span>
                </Field>
                <Field label="Currency">{record.currency}</Field>
                <Field label="Need by">{record.need_by_date ?? "—"}</Field>
                <Field label="Estimated total">
                  {money(record.estimated_total, record.currency)}
                </Field>
                <Field label="Submitted at">
                  {record.submitted_at
                    ? new Date(record.submitted_at).toLocaleString()
                    : "—"}
                </Field>
                <Field label="Approved at">
                  {record.approved_at
                    ? new Date(record.approved_at).toLocaleString()
                    : "—"}
                </Field>
                <Field label="Rejected at">
                  {record.rejected_at
                    ? new Date(record.rejected_at).toLocaleString()
                    : "—"}
                </Field>
                <Field label="Cancelled at">
                  {record.cancelled_at
                    ? new Date(record.cancelled_at).toLocaleString()
                    : "—"}
                </Field>
              </div>
            </Section>

            {record.justification && (
              <Section title="Justification">
                <p className="text-sm whitespace-pre-wrap">{record.justification}</p>
              </Section>
            )}
            {record.rejected_reason && (
              <Section title="Rejection reason">
                <p className="text-sm text-destructive whitespace-pre-wrap">
                  {record.rejected_reason}
                </p>
              </Section>
            )}
            {record.notes && (
              <Section title="Notes">
                <p className="text-sm whitespace-pre-wrap">{record.notes}</p>
              </Section>
            )}
          </TabsContent>

          <TabsContent value="lines" className="mt-4">
            {record.items.length === 0 ? (
              <EmptyState
                title="No line items"
                description="This requisition has no lines yet."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Est. unit</TableHead>
                      <TableHead className="text-right">Est. total</TableHead>
                      <TableHead>Suggested supplier</TableHead>
                      <TableHead>Need by</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.items.map((l, idx) => {
                      const sup = l.suggested_supplier_id
                        ? supplierById.get(l.suggested_supplier_id)
                        : null;
                      return (
                        <TableRow key={l.id}>
                          <TableCell>{l.sort_order ?? idx + 1}</TableCell>
                          <TableCell>{l.description}</TableCell>
                          <TableCell className="text-right">{l.quantity}</TableCell>
                          <TableCell className="text-right">
                            {money(l.estimated_unit_price, record.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            {money(
                              l.estimated_line_total ??
                                Number(l.quantity) * Number(l.estimated_unit_price),
                              record.currency,
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {sup?.contact?.name ?? sup?.supplier_code ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {l.need_by_date ?? "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="approvals" className="mt-4">
            {record.approvals.length === 0 ? (
              <EmptyState
                title="No approval activity yet"
                description="Approvals appear here once the requisition is submitted."
              />
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
                        <TableCell className="text-sm text-muted-foreground">
                          {a.comment ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(a.created_at).toLocaleString()}
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

      {/* Approve dialog */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve requisition</DialogTitle>
            <DialogDescription>
              Approvers cannot approve their own requisitions (Segregation of Duties).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Comment (optional)</Label>
              <Textarea
                value={approveComment}
                onChange={(e) => setApproveComment(e.target.value)}
                rows={3}
              />
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
                  () => approveRequisition(record.id, approveComment || undefined),
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
            <DialogDescription>
              A reason is required and will be visible to the requester.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason *</Label>
              <Textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={3}
              />
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
                  () => rejectRequisition(record.id, rejectReason.trim()),
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

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel requisition</DialogTitle>
            <DialogDescription>
              This closes the requisition without generating a PO.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason (optional)</Label>
              <Textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={3}
              />
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
                  () => cancelRequisition(record.id, cancelReason || undefined),
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
    </>
  );
}
