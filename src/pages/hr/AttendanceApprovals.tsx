/**
 * AttendanceApprovals — unified hub.
 *
 * Two tabs (Corrections | Overtime) over a shared two-pane layout:
 *   left  — pending queue list
 *   right — detail card with full context + Approve / Reject
 *
 * Replaces /hr/attendance/corrections and /hr/attendance/overtime as the
 * canonical approval surface. The legacy URLs continue to resolve via
 * redirects in AttendanceRoutes and may carry ?row=<id> to auto-open an
 * item from email links.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Inbox, Loader2, CheckCircle2, XCircle, Clock4 } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

import {
  useAttendanceCorrections,
  type AttendanceCorrection,
} from "@/hooks/hr/useAttendanceCorrections";
import { useAttendance } from "@/hooks/useAttendance";
import {
  useOvertimeRequests,
  type OvertimeRequest,
} from "@/hooks/hr/useOvertimeRequests";
import { RejectReasonDialog } from "@/components/attendance/RejectReasonDialog";
import { SavedViewMenu } from "@/components/attendance/SavedViewMenu";
import { useApprovalsHotkeys } from "@/hooks/hr/useApprovalsHotkeys";

type Tab = "corrections" | "overtime";

export default function AttendanceApprovals() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const initialTab = (params.get("tab") as Tab) === "overtime" ? "overtime" : "corrections";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [selectedId, setSelectedId] = useState<string | null>(
    params.get("row"),
  );

  const setTabAndUrl = (next: Tab) => {
    setTab(next);
    setSelectedId(null);
    navigate(`/hr/attendance/approvals?tab=${next}`, { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="text-sm text-muted-foreground">
            One queue for attendance corrections and overtime pre-approvals.
          </p>
        </div>
        <div className="action-buttons flex flex-wrap gap-2">
          <SavedViewMenu
            scope="approvals"
            currentFilters={{ tab }}
            onApply={(f) => {
              if (f.tab === "overtime" || f.tab === "corrections") {
                setTabAndUrl(f.tab as Tab);
              }
            }}
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTabAndUrl(v as Tab)}>
        <TabsList>
          <TabsTrigger value="corrections">Corrections</TabsTrigger>
          <TabsTrigger value="overtime">Overtime</TabsTrigger>
        </TabsList>

        <TabsContent value="corrections" className="mt-4">
          <CorrectionsPane
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </TabsContent>
        <TabsContent value="overtime" className="mt-4">
          <OvertimePane
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </TabsContent>
      </Tabs>

      <p className="text-[11px] text-muted-foreground tabular-nums pt-1">
        Keyboard: <kbd className="px-1 rounded border">J/K</kbd> nav ·
        <kbd className="px-1 rounded border ml-1">A</kbd> approve ·
        <kbd className="px-1 rounded border ml-1">R</kbd> reject ·
        <kbd className="px-1 rounded border ml-1">X</kbd> pick ·
        <kbd className="px-1 rounded border ml-1">Esc</kbd> clear
      </p>
    </div>
  );
}

/* -------------------- Corrections pane -------------------- */

function CorrectionsPane({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { pending, reviewed, isLoading } = useAttendanceCorrections();
  const { reviewCorrection } = useAttendance();
  const qc = useQueryClient();
  const [reviewing, setReviewing] = useState<{
    id: string;
    action: "approved" | "rejected";
  } | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulking, setBulking] = useState<"approved" | "rejected" | null>(null);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);

  // Auto-select the first row when nothing is selected.
  useEffect(() => {
    if (!selectedId && pending.length > 0) onSelect(pending[0].id);
  }, [selectedId, pending, onSelect]);

  // Drop selections for ids that are no longer pending.
  useEffect(() => {
    setPicked((prev) => {
      const ids = new Set(pending.map((p) => p.id));
      const next = new Set<string>();
      prev.forEach((id) => ids.has(id) && next.add(id));
      return next;
    });
  }, [pending]);

  const selected = pending.find((c) => c.id === selectedId)
    ?? reviewed.find((c) => c.id === selectedId)
    ?? null;

  const allPendingPicked = pending.length > 0 && pending.every((p) => picked.has(p.id));
  const toggleAll = () => {
    setPicked(allPendingPicked ? new Set() : new Set(pending.map((p) => p.id)));
  };
  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const runBulk = async (action: "approved" | "rejected", reason?: string) => {
    if (picked.size === 0) return;
    setBulking(action);
    const ids = Array.from(picked);
    const fn =
      action === "approved"
        ? "attendance_approve_correction"
        : "attendance_reject_correction";
    const note = reason && reason.length > 0 ? reason : null;
    const results = await Promise.allSettled(
      ids.map((id) =>
        supabase.rpc(fn as any, { _correction_id: id, _review_note: note }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled" && !(r.value as any).error).length;
    const failed = results.length - ok;
    if (failed === 0) {
      toast.success(`${action === "approved" ? "Approved" : "Rejected"} ${ok} request${ok === 1 ? "" : "s"}`);
    } else {
      toast.error(`${action === "approved" ? "Approved" : "Rejected"} ${ok}, ${failed} failed`);
    }
    setPicked(new Set());
    setBulking(null);
    setBulkRejectOpen(false);
    qc.invalidateQueries({ queryKey: ["attendance-corrections"] });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  };

  const submit = () => {
    if (!reviewing) return;
    reviewCorrection({
      id: reviewing.id,
      action: reviewing.action,
      note: note.trim() || undefined,
    });
    setReviewing(null);
    setNote("");
    onSelect(null);
  };

  // A2b — keyboard nav over pending queue.
  useApprovalsHotkeys({
    enabled: !reviewing && !bulkRejectOpen,
    ids: pending.map((p) => p.id),
    selectedId,
    onSelect,
    onApprove: (id) => setReviewing({ id, action: "approved" }),
    onReject: (id) => setReviewing({ id, action: "rejected" }),
    onTogglePick: togglePick,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card className="lg:max-h-[calc(100vh-220px)] overflow-hidden flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Pending</span>
            {pending.length > 0 && (
              <Badge variant="destructive" className="h-5 px-1.5">
                {pending.length}
              </Badge>
            )}
          </CardTitle>
          {pending.length > 0 && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={allPendingPicked}
                  onCheckedChange={toggleAll}
                  aria-label="Select all pending"
                />
                Select all
              </label>
              {picked.size > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {picked.size} picked
                </span>
              )}
            </div>
          )}
        </CardHeader>
        {picked.size > 0 && (
          <div className="px-3 pb-2 flex flex-wrap gap-2 border-b">
            <Button
              size="sm"
              disabled={!!bulking}
              onClick={() => runBulk("approved")}
            >
              {bulking === "approved" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Approve {picked.size}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!bulking}
              onClick={() => setBulkRejectOpen(true)}
            >
              {bulking === "rejected" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              <XCircle className="h-3.5 w-3.5 mr-1" />
              Reject {picked.size}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          </div>
        )}
        <CardContent className="p-0 overflow-y-auto">
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground m-4" />
          ) : pending.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="h-8 w-8 text-emerald-500" />}
              title="All caught up"
              body="No pending correction requests."
            />
          ) : (
            <ul className="divide-y">
              {pending.map((c) => (
                <CorrectionListItem
                  key={c.id}
                  item={c}
                  active={c.id === selectedId}
                  picked={picked.has(c.id)}
                  onPick={() => togglePick(c.id)}
                  onClick={() => onSelect(c.id)}
                />
              ))}
            </ul>
          )}
          {reviewed.length > 0 && (
            <>
              <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-t bg-muted/30">
                Recently reviewed
              </div>
              <ul className="divide-y">
                {reviewed.slice(0, 20).map((c) => (
                  <CorrectionListItem
                    key={c.id}
                    item={c}
                    active={c.id === selectedId}
                    muted
                    onClick={() => onSelect(c.id)}
                  />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="min-h-[400px]">
        {!selected ? (
          <EmptyState
            icon={<Inbox className="h-8 w-8 text-muted-foreground" />}
            title="No request selected"
            body="Pick a row from the queue to review the details."
          />
        ) : (
          <CardContent className="p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">
                  {selected.employee
                    ? `${selected.employee.first_name} ${selected.employee.last_name}`
                    : "Unknown employee"}
                  {selected.employee?.employee_number && (
                    <span className="text-muted-foreground font-normal ml-2 text-sm">
                      #{selected.employee.employee_number}
                    </span>
                  )}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {format(new Date(selected.attendance_date), "EEEE, MMMM d, yyyy")}
                </p>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            {/* Proposed times */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Proposed clock in</p>
                <p className="text-lg font-semibold tabular-nums">
                  {selected.proposed_clock_in
                    ? format(new Date(selected.proposed_clock_in), "hh:mm a")
                    : "—"}
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Proposed clock out</p>
                <p className="text-lg font-semibold tabular-nums">
                  {selected.proposed_clock_out
                    ? format(new Date(selected.proposed_clock_out), "hh:mm a")
                    : "—"}
                </p>
              </div>
            </div>

            {/* Reason */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Employee reason</p>
              <p className="text-sm italic">"{selected.reason}"</p>
            </div>

            <p className="text-xs text-muted-foreground">
              Requested {formatDistanceToNow(new Date(selected.requested_at), { addSuffix: true })}
              {selected.reviewed_at && (
                <>
                  {" · "}reviewed {formatDistanceToNow(new Date(selected.reviewed_at), { addSuffix: true })}
                </>
              )}
            </p>

            {selected.review_note && (
              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <p className="text-[10px] uppercase text-muted-foreground mb-1">Reviewer note</p>
                {selected.review_note}
              </div>
            )}

            {selected.status === "pending" && (
              <div className="flex gap-2 pt-2 border-t">
                <Button
                  onClick={() => setReviewing({ id: selected.id, action: "approved" })}
                >
                  <CheckCircle2 className="h-4 w-4 mr-1.5" />
                  Approve
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setReviewing({ id: selected.id, action: "rejected" })}
                >
                  <XCircle className="h-4 w-4 mr-1.5" />
                  Reject
                </Button>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Dialog
        open={!!reviewing}
        onOpenChange={(open) => {
          if (!open) {
            setReviewing(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewing?.action === "approved" ? "Approve correction" : "Reject correction"}
            </DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="Optional note for the employee…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>
              Cancel
            </Button>
            <Button
              variant={reviewing?.action === "approved" ? "default" : "destructive"}
              onClick={submit}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RejectReasonDialog
        open={bulkRejectOpen}
        onOpenChange={setBulkRejectOpen}
        kind="correction"
        count={picked.size}
        isSubmitting={bulking === "rejected"}
        onConfirm={(reason) => runBulk("rejected", reason)}
      />
    </div>
  );
}

function CorrectionListItem({
  item,
  active,
  muted,
  picked,
  onPick,
  onClick,
}: {
  item: AttendanceCorrection;
  active: boolean;
  muted?: boolean;
  picked?: boolean;
  onPick?: () => void;
  onClick: () => void;
}) {
  return (
    <li>
      <div
        className={cn(
          "w-full px-3 py-3 hover:bg-muted/50 transition-colors flex items-start gap-2",
          active && "bg-primary/5 border-l-2 border-l-primary",
          muted && "opacity-70",
        )}
      >
        {onPick && (
          <div className="pt-1" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={picked}
              onCheckedChange={onPick}
              aria-label="Pick for bulk action"
            />
          </div>
        )}
        <button
          type="button"
          onClick={onClick}
          className="flex-1 text-left flex flex-col gap-1 min-w-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium truncate">
              {item.employee
                ? `${item.employee.first_name} ${item.employee.last_name}`
                : "Unknown"}
            </span>
            <StatusBadge status={item.status} compact />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{format(new Date(item.attendance_date), "MMM d")}</span>
            <span>{formatDistanceToNow(new Date(item.requested_at), { addSuffix: true })}</span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-1">{item.reason}</p>
        </button>
      </div>
    </li>
  );
}

/* -------------------- Overtime pane -------------------- */

function OvertimePane({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { requests, isLoading, decide, isDeciding } = useOvertimeRequests("pending");
  const reviewedQ = useOvertimeRequests("approved");
  const reviewed = reviewedQ.requests;
  const qc = useQueryClient();

  const [rejecting, setRejecting] = useState<OvertimeRequest | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulking, setBulking] = useState<"approved" | "rejected" | null>(null);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);

  useEffect(() => {
    if (!selectedId && requests.length > 0) onSelect(requests[0].id);
  }, [selectedId, requests, onSelect]);

  useEffect(() => {
    setPicked((prev) => {
      const ids = new Set(requests.map((r) => r.id));
      const next = new Set<string>();
      prev.forEach((id) => ids.has(id) && next.add(id));
      return next;
    });
  }, [requests]);

  const selected = requests.find((r) => r.id === selectedId)
    ?? reviewed.find((r) => r.id === selectedId)
    ?? null;

  const allPicked = requests.length > 0 && requests.every((r) => picked.has(r.id));
  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(requests.map((r) => r.id)));
  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const runBulk = async (action: "approved" | "rejected", reason?: string) => {
    if (picked.size === 0) return;
    setBulking(action);
    const ids = Array.from(picked);
    const _reason = reason && reason.length > 0 ? reason : null;
    const results = await Promise.allSettled(
      ids.map((id) =>
        supabase.rpc("overtime_request_decide" as any, {
          _id: id,
          _decision: action,
          _reason,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled" && !(r.value as any).error).length;
    const failed = results.length - ok;
    if (failed === 0) {
      toast.success(`${action === "approved" ? "Approved" : "Rejected"} ${ok} request${ok === 1 ? "" : "s"}`);
    } else {
      toast.error(`${action === "approved" ? "Approved" : "Rejected"} ${ok}, ${failed} failed`);
    }
    setPicked(new Set());
    setBulking(null);
    setBulkRejectOpen(false);
    qc.invalidateQueries({ queryKey: ["overtime-requests"] });
  };

  const submitReject = (reason: string) => {
    if (!rejecting) return;
    decide({ id: rejecting.id, decision: "rejected", reason });
    setRejecting(null);
    onSelect(null);
  };

  // A2b — keyboard nav over pending overtime queue.
  useApprovalsHotkeys({
    enabled: !rejecting && !bulkRejectOpen,
    ids: requests.map((r) => r.id),
    selectedId,
    onSelect,
    onApprove: (id) => decide({ id, decision: "approved" }),
    onReject: (id) => {
      const r = requests.find((x) => x.id === id);
      if (r) setRejecting(r);
    },
    onTogglePick: togglePick,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card className="lg:max-h-[calc(100vh-220px)] overflow-hidden flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Pending</span>
            {requests.length > 0 && (
              <Badge variant="destructive" className="h-5 px-1.5">
                {requests.length}
              </Badge>
            )}
          </CardTitle>
          {requests.length > 0 && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={allPicked}
                  onCheckedChange={toggleAll}
                  aria-label="Select all pending"
                />
                Select all
              </label>
              {picked.size > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {picked.size} picked
                </span>
              )}
            </div>
          )}
        </CardHeader>
        {picked.size > 0 && (
          <div className="px-3 pb-2 flex flex-wrap gap-2 border-b">
            <Button size="sm" disabled={!!bulking} onClick={() => runBulk("approved")}>
              {bulking === "approved" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              Approve {picked.size}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!bulking}
              onClick={() => setBulkRejectOpen(true)}
            >
              {bulking === "rejected" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              <XCircle className="h-3.5 w-3.5 mr-1" />
              Reject {picked.size}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          </div>
        )}
        <CardContent className="p-0 overflow-y-auto">
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground m-4" />
          ) : requests.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="h-8 w-8 text-emerald-500" />}
              title="No pending overtime"
              body="Employees haven't submitted any overtime requests."
            />
          ) : (
            <ul className="divide-y">
              {requests.map((r) => (
                <OvertimeListItem
                  key={r.id}
                  item={r}
                  active={r.id === selectedId}
                  picked={picked.has(r.id)}
                  onPick={() => togglePick(r.id)}
                  onClick={() => onSelect(r.id)}
                />
              ))}
            </ul>
          )}
          {reviewed.length > 0 && (
            <>
              <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-t bg-muted/30">
                Recently approved
              </div>
              <ul className="divide-y">
                {reviewed.slice(0, 20).map((r) => (
                  <OvertimeListItem
                    key={r.id}
                    item={r}
                    active={r.id === selectedId}
                    muted
                    onClick={() => onSelect(r.id)}
                  />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="min-h-[400px]">
        {!selected ? (
          <EmptyState
            icon={<Clock4 className="h-8 w-8 text-muted-foreground" />}
            title="No request selected"
            body="Pick a row from the queue to review the details."
          />
        ) : (
          <CardContent className="p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">
                  {selected.employee
                    ? `${selected.employee.first_name} ${selected.employee.last_name}`
                    : "Unknown employee"}
                  {selected.employee?.employee_number && (
                    <span className="text-muted-foreground font-normal ml-2 text-sm">
                      #{selected.employee.employee_number}
                    </span>
                  )}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {format(new Date(selected.ot_date), "EEEE, MMMM d, yyyy")}
                </p>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Hours requested</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {Number(selected.requested_hours).toFixed(2)}h
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground">Submitted</p>
                <p className="text-sm tabular-nums">
                  {formatDistanceToNow(new Date(selected.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Reason</p>
              <p className="text-sm italic">
                {selected.reason ? `"${selected.reason}"` : "— no reason provided —"}
              </p>
            </div>

            {selected.rejection_reason && (
              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <p className="text-[10px] uppercase text-muted-foreground mb-1">Rejection reason</p>
                {selected.rejection_reason}
              </div>
            )}

            {selected.status === "pending" && (
              <div className="flex gap-2 pt-2 border-t">
                <Button
                  disabled={isDeciding}
                  onClick={() => decide({ id: selected.id, decision: "approved" })}
                >
                  <CheckCircle2 className="h-4 w-4 mr-1.5" />
                  Approve
                </Button>
                <Button
                  variant="outline"
                  disabled={isDeciding}
                  onClick={() => setRejecting(selected)}
                >
                  <XCircle className="h-4 w-4 mr-1.5" />
                  Reject
                </Button>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <RejectReasonDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        kind="overtime request"
        count={1}
        isSubmitting={isDeciding}
        onConfirm={submitReject}
      />

      <RejectReasonDialog
        open={bulkRejectOpen}
        onOpenChange={setBulkRejectOpen}
        kind="overtime request"
        count={picked.size}
        isSubmitting={bulking === "rejected"}
        onConfirm={(r) => runBulk("rejected", r)}
      />
    </div>
  );
}

function OvertimeListItem({
  item,
  active,
  muted,
  picked,
  onPick,
  onClick,
}: {
  item: OvertimeRequest;
  active: boolean;
  muted?: boolean;
  picked?: boolean;
  onPick?: () => void;
  onClick: () => void;
}) {
  return (
    <li>
      <div
        className={cn(
          "w-full px-3 py-3 hover:bg-muted/50 transition-colors flex items-start gap-2",
          active && "bg-primary/5 border-l-2 border-l-primary",
          muted && "opacity-70",
        )}
      >
        {onPick && (
          <div className="pt-1" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={picked}
              onCheckedChange={onPick}
              aria-label="Pick for bulk action"
            />
          </div>
        )}
        <button
          type="button"
          onClick={onClick}
          className="flex-1 text-left flex flex-col gap-1 min-w-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium truncate">
              {item.employee
                ? `${item.employee.first_name} ${item.employee.last_name}`
                : "Unknown"}
            </span>
            <span className="text-sm tabular-nums font-medium">
              {Number(item.requested_hours).toFixed(1)}h
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{format(new Date(item.ot_date), "MMM d")}</span>
            <StatusBadge status={item.status} compact />
          </div>
        </button>
      </div>
    </li>
  );
}

/* -------------------- Shared helpers -------------------- */

function StatusBadge({ status, compact }: { status: string; compact?: boolean }) {
  const styles: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800 border-amber-200",
    approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
    rejected: "bg-rose-100 text-rose-800 border-rose-200",
    cancelled: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        styles[status] ?? "bg-muted text-muted-foreground",
        compact && "h-4 px-1 text-[10px]",
      )}
    >
      {status}
    </Badge>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-4 gap-2">
      {icon}
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground max-w-xs">{body}</p>
    </div>
  );
}
