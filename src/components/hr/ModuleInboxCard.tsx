/**
 * ModuleInboxCard — "work waiting" card for the Employees domain.
 *
 * Attendance / timesheet / leave inboxes were retired with the HR excision;
 * the employees queue is the only remaining approval surface.
 */
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Hourglass,
  LogOut,
  UserCog,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEmployeesInboxCounts } from "@/hooks/hr/useEmployeesInboxCounts";

export type InboxModule = "employees";

interface Row {
  to: string;
  icon: typeof ClipboardCheck;
  label: string;
  count: number;
  emptyLabel: string;
}

interface Props {
  module?: InboxModule;
}

function useRows(): { title: string; total: number; isLoading: boolean; rows: Row[] } {
  const emp = useEmployeesInboxCounts();
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
        to: "/hr/employees?tab=onboarding",
        icon: Hourglass,
        label: "Stalled onboarding (>30d)",
        count: emp.counts.stalledOnboarding,
        emptyLabel: "No stalled onboarding",
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

export function ModuleInboxCard(_props: Props = {}) {
  const { title, total, isLoading, rows } = useRows();
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
 * ModuleInboxStrip — collapses to a single positive row when the employees
 * queue is empty, so the dashboard stays quiet on a normal morning.
 */
export function ModuleInboxStrip() {
  const emp = useEmployeesInboxCounts();

  if (!emp.isLoading && emp.counts.total === 0) {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="h-9 w-9 rounded-md flex items-center justify-center bg-emerald-500/10 text-emerald-600 shrink-0">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">All inboxes clear</div>
            <div className="text-xs text-muted-foreground">No employee items waiting on you.</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <ModuleInboxCard />
    </div>
  );
}
