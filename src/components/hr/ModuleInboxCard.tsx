/**
 * ModuleInboxCard — generalized "work waiting" card for HR sub-apps.
 *
 * One card pattern, three flavours: attendance, timesheets, leave. Each
 * variant pulls from its own inbox-counts hook so the badges match the
 * sub-nav numbers, and clicking any row deep-links to the corresponding
 * approval surface.
 *
 * Designed for HRDashboard so managers see all three queues in one strip.
 */
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CalendarOff,
  CheckCircle2,
  ClipboardCheck,
  Clock4,
  FileSignature,
  FileWarning,
  Hourglass,
  LogOut,
  ShieldAlert,
  ShieldCheck,
  Timer,
  UserCog,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAttendanceInboxCounts } from "@/hooks/hr/useAttendanceInboxCounts";
import { useTimesheetInboxCounts } from "@/hooks/timesheets/useTimesheetInboxCounts";
import { useLeaveInboxCounts } from "@/hooks/leave/useLeaveInboxCounts";
import { useEmployeesInboxCounts } from "@/hooks/hr/useEmployeesInboxCounts";


export type InboxModule = "attendance" | "timesheets" | "leave" | "employees";

interface Row {
  to: string;
  icon: typeof ClipboardCheck;
  label: string;
  count: number;
  emptyLabel: string;
}

interface Props {
  module: InboxModule;
}

function useRows(module: InboxModule): { title: string; total: number; isLoading: boolean; rows: Row[] } {
  const att = useAttendanceInboxCounts();
  const ts = useTimesheetInboxCounts();
  const lv = useLeaveInboxCounts();
  const emp = useEmployeesInboxCounts();

  if (module === "attendance") {
    return {
      title: "Attendance",
      total: att.counts.total,
      isLoading: att.isLoading,
      rows: [
        {
          to: "/hr/attendance/approvals?tab=corrections",
          icon: ClipboardCheck,
          label: "Corrections",
          count: att.counts.corrections,
          emptyLabel: "No pending corrections",
        },
        {
          to: "/hr/attendance/approvals?tab=overtime",
          icon: Clock4,
          label: "Overtime requests",
          count: att.counts.overtime,
          emptyLabel: "No pending overtime",
        },
        {
          to: "/hr/attendance/devices",
          icon: ShieldAlert,
          label: "Devices to review",
          count: att.counts.devicesDisabled,
          emptyLabel: "All devices active",
        },
      ],
    };
  }

  if (module === "timesheets") {
    return {
      title: "Timesheets",
      total: ts.counts.total,
      isLoading: ts.isLoading,
      rows: [
        {
          to: "/timesheets/approvals",
          icon: Timer,
          label: "Submitted for approval",
          count: ts.counts.pendingApprovals,
          emptyLabel: "No pending timesheets",
        },
      ],
    };
  }

  if (module === "leave") {
    return {
      title: "Time-off",
      total: lv.counts.total,
      isLoading: lv.isLoading,
      rows: [
        {
          to: "/hr/leave/approvals",
          icon: CalendarOff,
          label: "Leave requests",
          count: lv.counts.pending,
          emptyLabel: "No pending requests",
        },
        {
          to: "/hr/leave/approvals",
          icon: CalendarOff,
          label: "Second-level approval",
          count: lv.counts.pendingSecondLevel,
          emptyLabel: "Nothing waiting on you",
        },
      ],
    };
  }

  return {
    title: "Employees",
    total: emp.counts.total,
    isLoading: emp.isLoading,
    rows: [
      {
        to: "/hr/employees?tab=onboarding",
        icon: UserCog,
        label: "Onboarding tasks",
        count: emp.counts.pendingOnboarding,
        emptyLabel: "Onboarding caught up",
      },
      {
        to: "/hr/employees?tab=contracts",
        icon: FileSignature,
        label: "Contracts expiring (90d)",
        count: emp.counts.expiringContracts,
        emptyLabel: "No renewals due",
      },
      {
        to: "/hr/employees?tab=exit",
        icon: LogOut,
        label: "Exit clearance items",
        count: emp.counts.openExitClearance,
        emptyLabel: "No active offboardings",
      },
    ],
  };
}

export function ModuleInboxCard({ module }: Props) {
  const { title, total, isLoading, rows } = useRows(module);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          {total > 0 && (
            <Badge variant="destructive" className="h-5 px-1.5 text-xs">
              {total}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {rows.map((row) => {
            const Icon = row.icon;
            const hasWork = row.count > 0;
            return (
              <li key={row.to}>
                <Link
                  to={row.to}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={
                        "h-8 w-8 rounded-md flex items-center justify-center shrink-0 " +
                        (hasWork ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")
                      }
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{row.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {isLoading
                          ? "Loading…"
                          : hasWork
                            ? `${row.count} waiting`
                            : row.emptyLabel}
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * ModuleInboxStrip — three-card strip that collapses to a single positive
 * "All inboxes clear" row when every module's queue is empty. Keeps the
 * HRDashboard quiet on a normal morning instead of showing three empty
 * cards stacked side-by-side.
 */
export function ModuleInboxStrip() {
  const att = useAttendanceInboxCounts();
  const ts = useTimesheetInboxCounts();
  const lv = useLeaveInboxCounts();
  const emp = useEmployeesInboxCounts();
  const isLoading = att.isLoading || ts.isLoading || lv.isLoading || emp.isLoading;
  const total =
    att.counts.total + ts.counts.total + lv.counts.total + emp.counts.total;

  if (!isLoading && total === 0) {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="h-9 w-9 rounded-md flex items-center justify-center bg-emerald-500/10 text-emerald-600 shrink-0">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">All inboxes clear</div>
            <div className="text-xs text-muted-foreground">
              No attendance, timesheet, time-off, or employee items waiting on you.
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      <ModuleInboxCard module="attendance" />
      <ModuleInboxCard module="timesheets" />
      <ModuleInboxCard module="leave" />
      <ModuleInboxCard module="employees" />
    </div>
  );
}

