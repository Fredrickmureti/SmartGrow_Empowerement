/**
 * LeaveApprovals — dedicated approvals queue for Time Off.
 *
 * Mirrors AttendanceApprovals: KpiStrip + ManagerTriageBanner + J/K/A/R/Esc
 * keyboard shortcuts via the shared useListHotkeys primitive. The actual
 * row UI lives in LeaveApprovalList; this page owns selection + hotkeys.
 */
import { useMemo, useState, useCallback, useEffect } from "react";
import { useLeaveRequests, useTeamLeaveRequests } from "@/hooks/leave";
import { LeaveApprovalList } from "@/components/leave/LeaveApprovalList";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lock, Clock, CheckCircle2, XCircle, Inbox, Keyboard, Check, X } from "lucide-react";
import { KpiStrip, type KpiTile } from "@/components/hr/KpiStrip";
import { ManagerTriageBanner } from "@/components/hr/ManagerTriageBanner";
import { useListHotkeys } from "@/hooks/hr/useListHotkeys";
import { toast } from "sonner";


export default function LeaveApprovals() {
  const { approveRequest, approveSecondLevel, rejectRequest } = useLeaveRequests();
  const {
    teamLeaveRequests,
    pendingCount,
    canApproveLeave,
    isManager,
    isLoading,
  } = useTeamLeaveRequests();

  const tiles = useMemo<KpiTile[]>(() => {
    const all = teamLeaveRequests ?? [];
    const by = (s: string) => all.filter((r: any) => r.status === s).length;
    return [
      { key: "pending", label: "Pending", value: by("pending"), icon: Clock, tone: "amber" },
      {
        key: "second",
        label: "Awaiting final",
        value: by("pending_second_approval"),
        icon: Inbox,
        tone: "amber",
      },
      { key: "approved", label: "Approved", value: by("approved"), icon: CheckCircle2, tone: "emerald" },
      { key: "rejected", label: "Rejected", value: by("rejected"), icon: XCircle, tone: "rose" },
    ];
  }, [teamLeaveRequests]);

  // IDs of pending rows drive hotkey navigation.
  const pendingIds = useMemo(
    () =>
      (teamLeaveRequests ?? [])
        .filter((r: any) => r.status === "pending" || r.status === "pending_second_approval")
        .map((r: any) => r.id as string),
    [teamLeaveRequests],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // Prune selections whose row is no longer pending (e.g. after a refresh).
  useEffect(() => {
    setSelectedIds((prev) => {
      const valid = new Set(pendingIds);
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pendingIds]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleApprove = useCallback(
    (id: string) => {
      const row = (teamLeaveRequests ?? []).find((r: any) => r.id === id) as any;
      if (!row) return;
      const op =
        row.status === "pending_second_approval" ? approveSecondLevel : approveRequest;
      Promise.resolve(op(id))
        .then(() => toast.success("Request approved"))
        .catch((e: any) => toast.error(e?.message ?? "Could not approve"));
    },
    [teamLeaveRequests, approveRequest, approveSecondLevel],
  );

  const handleReject = useCallback(
    (id: string) => {
      const reason = prompt("Rejection reason (visible to the requester):");
      if (!reason || !reason.trim()) return;
      Promise.resolve(rejectRequest(id, reason.trim()))
        .then(() => toast.success("Request rejected"))
        .catch((e: any) => toast.error(e?.message ?? "Could not reject"));
    },
    [rejectRequest],
  );

  const bulkApprove = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const all = teamLeaveRequests ?? [];
    let ok = 0, fail = 0;
    for (const id of ids) {
      const row = all.find((r: any) => r.id === id) as any;
      if (!row) { fail += 1; continue; }
      const op =
        row.status === "pending_second_approval" ? approveSecondLevel : approveRequest;
      try { await op(id); ok += 1; } catch { fail += 1; }
    }
    if (ok > 0) toast.success(`Approved ${ok} request${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} could not be approved`);
    clearSelection();
  }, [selectedIds, teamLeaveRequests, approveRequest, approveSecondLevel, clearSelection]);

  const bulkReject = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const reason = prompt(
      `Rejection reason for ${ids.length} request${ids.length === 1 ? "" : "s"} (visible to requesters):`,
    );
    if (!reason || !reason.trim()) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await rejectRequest(id, reason.trim()); ok += 1; } catch { fail += 1; }
    }
    if (ok > 0) toast.success(`Rejected ${ok} request${ok === 1 ? "" : "s"}`);
    if (fail > 0) toast.error(`${fail} could not be rejected`);
    clearSelection();
  }, [selectedIds, rejectRequest, clearSelection]);

  useListHotkeys({
    enabled: pendingIds.length > 0,
    ids: pendingIds,
    selectedId,
    onSelect: setSelectedId,
    onApprove: handleApprove,
    onReject: handleReject,
  });


  if (!canApproveLeave && !isManager) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mb-3" />
          <h3 className="font-semibold">Manager access required</h3>
          <p className="text-sm text-muted-foreground mt-1">
            You need leave-approval rights or direct reports to review time-off requests.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ManagerTriageBanner module="leave" />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Leave Approvals</h1>
          <p className="text-sm text-muted-foreground">
            Review and decide on pending time-off requests
            {pendingCount > 0 ? ` (${pendingCount} waiting)` : ""}.
          </p>
        </div>
        <div className="text-xs text-muted-foreground hidden sm:flex items-center gap-1.5">
          <Keyboard className="h-3.5 w-3.5" />
          <span>J/K navigate · A approve · R reject · Esc clear</span>
        </div>
      </div>
      <KpiStrip tiles={tiles} />
      <LeaveApprovalList
        requests={teamLeaveRequests}
        onApprove={approveRequest}
        onApproveSecondLevel={approveSecondLevel}
        onReject={rejectRequest}
        isLoading={isLoading}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
      />

      {selectedIds.size > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75 px-4 py-3 shadow-lg"
        >
          <div className="mx-auto max-w-5xl flex items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-medium">{selectedIds.size}</span>{" "}
              selected
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                Clear
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-red-600 hover:text-red-700"
                onClick={bulkReject}
              >
                <X className="h-4 w-4 mr-1" /> Reject all
              </Button>
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={bulkApprove}
              >
                <Check className="h-4 w-4 mr-1" /> Approve all
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
