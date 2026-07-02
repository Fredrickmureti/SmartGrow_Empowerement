/**
 * ManagerTriageBanner — uniform "items waiting on your approval" banner
 * surfaced on the self-service portals (/me/attendance, /me/timesheets,
 * /me/leave) so a team lead doesn't need to leave the personal portal
 * to notice queued approvals.
 *
 * Driven by `module`. Reads the matching inbox-count hook and the
 * matching permission gate — renders nothing when the user is not a
 * manager, lacks permission, or the queue is empty.
 *
 * Replaces the hand-rolled banner that previously lived inline in
 * MyAttendance, and brings parity to the other two portal pages.
 */
import { Link } from "react-router-dom";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/usePermissions";
import type { Permission } from "@/lib/permissions";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useAttendanceInboxCounts } from "@/hooks/hr/useAttendanceInboxCounts";
import { useTimesheetInboxCounts } from "@/hooks/timesheets/useTimesheetInboxCounts";
import { useLeaveInboxCounts } from "@/hooks/leave/useLeaveInboxCounts";

export type TriageModule = "attendance" | "timesheets" | "leave";

interface Config {
  permission: Permission;
  reviewPath: string;
  noun: string;
}

const CONFIG: Record<TriageModule, Config> = {
  attendance: { permission: "manageAttendance", reviewPath: "/hr/attendance/approvals", noun: "attendance" },
  timesheets: { permission: "approveTimesheets", reviewPath: "/timesheets/approvals", noun: "timesheet" },
  leave: { permission: "approveLeave", reviewPath: "/hr/leave/approvals", noun: "leave" },
};

function useTotal(module: TriageModule): number {
  const att = useAttendanceInboxCounts();
  const ts = useTimesheetInboxCounts();
  const lv = useLeaveInboxCounts();
  if (module === "attendance") return att.counts.total;
  if (module === "timesheets") return ts.counts.total;
  return lv.counts.total;
}

export interface ManagerTriageBannerProps {
  module: TriageModule;
}

export function ManagerTriageBanner({ module }: ManagerTriageBannerProps) {
  const { can } = usePermissions();
  const { isManager } = useCurrentEmployee();
  const cfg = CONFIG[module];
  const allowed = can(cfg.permission);
  const total = useTotal(module);

  if (!allowed && !isManager) return null;
  if (total <= 0) return null;

  return (
    <div
      role="status"
      className="rounded-md border bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/50 p-3 flex items-center justify-between gap-3"
    >
      <div className="flex items-center gap-2 text-sm">
        <Inbox className="h-4 w-4 text-amber-700 dark:text-amber-400" />
        <span>
          <strong>{total}</strong> {cfg.noun} item{total === 1 ? "" : "s"} waiting on your approval.
        </span>
      </div>
      <Button asChild size="sm" variant="outline">
        <Link to={cfg.reviewPath}>Review</Link>
      </Button>
    </div>
  );
}
