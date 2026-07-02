/**
 * AttendanceInboxCard — manager command-center inbox.
 *
 * Surfaces pending corrections, pending overtime requests, and disabled
 * (unverified) devices in one card with direct links. Uses the unified
 * `useAttendanceInboxCounts` hook so the numbers match the sub-nav badge.
 */
import { Link } from "react-router-dom";
import { ArrowRight, ClipboardCheck, Clock4, ShieldAlert, WifiOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAttendanceInboxCounts } from "@/hooks/hr/useAttendanceInboxCounts";

interface Row {
  to: string;
  icon: typeof ClipboardCheck;
  label: string;
  count: number;
  emptyLabel: string;
}

export function AttendanceInboxCard() {
  const { counts, isLoading } = useAttendanceInboxCounts();

  const rows: Row[] = [
    {
      to: "/hr/attendance/approvals?tab=corrections",
      icon: ClipboardCheck,
      label: "Corrections",
      count: counts.corrections,
      emptyLabel: "No pending corrections",
    },
    {
      to: "/hr/attendance/approvals?tab=overtime",
      icon: Clock4,
      label: "Overtime requests",
      count: counts.overtime,
      emptyLabel: "No pending overtime",
    },
    {
      to: "/hr/attendance/devices",
      icon: ShieldAlert,
      label: "Devices to review",
      count: counts.devicesDisabled,
      emptyLabel: "All devices active",
    },
    {
      to: "/hr/attendance/devices?filter=stale",
      icon: WifiOff,
      label: "Devices silent >24h",
      count: counts.devicesStale,
      emptyLabel: "All devices reporting",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Inbox</CardTitle>
          {counts.total > 0 && (
            <Badge variant="destructive" className="h-5 px-1.5 text-xs">
              {counts.total}
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
