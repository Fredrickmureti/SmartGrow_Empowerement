/**
 * TimesheetApprovals — manager / HR view of pending submissions.
 *
 * Adopts the cross-module HR primitives (KpiStrip, ManagerTriageBanner) and the
 * shared useListHotkeys for J/K/A/R/Esc keyboard navigation, matching the
 * Attendance + Leave approvals UX.
 */
import { useMemo, useState, useCallback } from "react";
import {
  useTimesheets,
  useTeamTimesheets,
  useTimesheetApprovalCapabilities,
} from "@/hooks/timesheets";
import { TimesheetApprovalList } from "@/components/timesheets/TimesheetApprovalList";
import { Card, CardContent } from "@/components/ui/card";
import { Lock, CheckCircle2, ClipboardCheck, Clock4, XCircle, Keyboard } from "lucide-react";
import { KpiStrip, type KpiTile } from "@/components/hr/KpiStrip";
import { ManagerTriageBanner } from "@/components/hr/ManagerTriageBanner";
import { useListHotkeys } from "@/hooks/hr/useListHotkeys";
import { toast } from "sonner";

export default function TimesheetApprovals() {
  const { approveTimesheets, rejectTimesheets } = useTimesheets();
  const {
    pendingSubmissions,
    teamSubmissions,
    canApproveTimesheets,
    isManager,
    isLoading,
  } = useTeamTimesheets() as any;

  const tiles = useMemo<KpiTile[]>(() => {
    const all = (teamSubmissions ?? []) as Array<{ status?: string }>;
    const by = (s: string) => all.filter((r) => r.status === s).length;
    return [
      { key: "pending", label: "Pending", value: by("submitted"), icon: ClipboardCheck, tone: "amber" },
      { key: "approved", label: "Approved", value: by("approved"), icon: CheckCircle2, tone: "emerald" },
      { key: "rejected", label: "Rejected", value: by("rejected"), icon: XCircle, tone: "rose" },
      { key: "total", label: "In scope", value: all.length, icon: Clock4, tone: "neutral" },
    ];
  }, [teamSubmissions]);

  const pendingIds = useMemo(
    () => (pendingSubmissions ?? []).map((s: any) => s.id as string),
    [pendingSubmissions],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Server-authoritative: lifecycle + competence + Governance self-action verdict.
  const { capabilities, refresh: refreshCapabilities } =
    useTimesheetApprovalCapabilities(pendingIds);

  const handleApprove = useCallback(
    (id: string) => {
      const cap = capabilities[id];
      if (cap && !cap.canApprove) {
        toast.error(
          cap.reason === "self_action_blocked"
            ? "Governance blocks approving your own timesheet. Request an exception first."
            : "You are not allowed to approve this submission.",
        );
        return;
      }
      Promise.resolve(approveTimesheets(id))
        .then(() => toast.success("Timesheet approved"))
        .catch((e: any) => toast.error(e?.message ?? "Could not approve"))
        .finally(() => void refreshCapabilities());
    },
    [approveTimesheets, capabilities, refreshCapabilities],
  );
  const handleReject = useCallback(
    (id: string) => {
      const reason = prompt("Rejection reason:");
      if (!reason || !reason.trim()) return;
      Promise.resolve(rejectTimesheets(id, reason.trim()))
        .then(() => toast.success("Timesheet rejected"))
        .catch((e: any) => toast.error(e?.message ?? "Could not reject"))
        .finally(() => void refreshCapabilities());
    },
    [rejectTimesheets, refreshCapabilities],
  );

  useListHotkeys({
    enabled: pendingIds.length > 0,
    ids: pendingIds,
    selectedId,
    onSelect: setSelectedId,
    onApprove: handleApprove,
    onReject: handleReject,
  });

  if (!canApproveTimesheets && !isManager) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mb-3" />
          <h3 className="font-semibold">Manager access required</h3>
          <p className="text-sm text-muted-foreground mt-1">
            You need approval rights or direct reports to review timesheets.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ManagerTriageBanner module="timesheets" />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team Approvals</h1>
          <p className="text-sm text-muted-foreground">
            Review and approve pending timesheet submissions from your team.
          </p>
        </div>
        <div className="text-xs text-muted-foreground hidden sm:flex items-center gap-1.5">
          <Keyboard className="h-3.5 w-3.5" />
          <span>J/K navigate · A approve · R reject · Esc clear</span>
        </div>
      </div>
      <KpiStrip tiles={tiles} />
      <TimesheetApprovalList
        submissions={pendingSubmissions}
        onApprove={approveTimesheets}
        onReject={rejectTimesheets}
        isLoading={isLoading}
      />
    </div>
  );
}
