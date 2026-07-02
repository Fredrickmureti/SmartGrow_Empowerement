/**
 * FilingCalendarPanel — surfaces upcoming and overdue statutory returns
 * powered by the `payroll_filing_calendar` DB view. Country-agnostic:
 * every row, due date, and authority comes from the installed
 * localization pack's return templates.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CalendarClock, CheckCircle2, FileText, GitBranch, PackageOpen, ShieldCheck } from "lucide-react";
import { format, parseISO, differenceInDays } from "date-fns";
import { useFilingCalendar, useHasInstalledLocalizationPack, type FilingCalendarEntry } from "@/hooks/payroll/useStatutoryReturns";

const STATE_BADGE: Record<FilingCalendarEntry["state"], string> = {
  not_started:      "bg-zinc-200 text-zinc-700",
  draft:            "bg-zinc-200 text-zinc-700",
  generated:        "bg-blue-100 text-blue-800",
  pending_approval: "bg-amber-100 text-amber-800",
  awaiting_ack:     "bg-indigo-100 text-indigo-800",
  filed:            "bg-emerald-100 text-emerald-800",
  rejected:         "bg-red-100 text-red-800",
};

const STATE_LABEL: Record<FilingCalendarEntry["state"], string> = {
  not_started:      "Not started",
  draft:            "Draft",
  generated:        "Generated",
  pending_approval: "Pending approval",
  awaiting_ack:     "Awaiting ack",
  filed:            "Filed",
  rejected:         "Rejected",
};


export function FilingCalendarPanel() {
  const { data: entries = [], isLoading } = useFilingCalendar();
  const { data: hasInstalledPack = false } = useHasInstalledLocalizationPack();

  const overdue = entries.filter((e) => e.is_overdue);
  const dueSoon = entries.filter(
    (e) => !e.is_overdue && e.state !== "filed" &&
      differenceInDays(parseISO(e.due_date), new Date()) <= 7,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5" />
          Statutory Filing Calendar
          {overdue.length > 0 && (
            <Badge variant="destructive" className="ml-2">
              {overdue.length} overdue
            </Badge>
          )}
          {dueSoon.length > 0 && (
            <Badge className="bg-amber-100 text-amber-800 ml-2">
              {dueSoon.length} due in 7 days
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : entries.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            {hasInstalledPack
              ? "Localization pack installed for this business, but it publishes no statutory return templates. Contact the pack publisher."
              : "No statutory return templates available. Install a country localization pack for this business to populate this calendar."}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Return</TableHead>
                <TableHead>Authority</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => {
                const due = parseISO(e.due_date);
                const days = differenceInDays(due, new Date());
                return (
                  <TableRow key={`${e.template_code}-${e.period_end}`}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div>{e.display_name}</div>
                          <div className="text-xs text-muted-foreground">{e.template_code}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {e.authority_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {format(parseISO(e.period_start), "d MMM")} –{" "}
                      {format(parseISO(e.period_end), "d MMM yyyy")}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {e.is_overdue ? (
                          <AlertTriangle className="h-4 w-4 text-red-600" />
                        ) : days <= 7 ? (
                          <CalendarClock className="h-4 w-4 text-amber-600" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                        )}
                        <div>
                          <div className="text-sm">{format(due, "d MMM yyyy")}</div>
                          <div className={`text-xs ${e.is_overdue ? "text-red-600" : "text-muted-foreground"}`}>
                            {e.is_overdue
                              ? `${Math.abs(days)} days overdue`
                              : days === 0
                              ? "Due today"
                              : `${days} days`}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge className={STATE_BADGE[e.state]}>{STATE_LABEL[e.state]}</Badge>
                        {e.is_overridden && (
                          <Badge variant="outline" className="gap-1 border-violet-300 text-violet-700">
                            <GitBranch className="h-3 w-3" /> Overridden
                          </Badge>
                        )}
                        {e.override_stale && (
                          <Badge variant="outline" className="gap-1 border-amber-400 text-amber-700">
                            <AlertTriangle className="h-3 w-3" /> Drift
                          </Badge>
                        )}
                        {e.upgrade_pending && (
                          <Badge variant="outline" className="gap-1 border-blue-300 text-blue-700">
                            <PackageOpen className="h-3 w-3" /> Upgrade pending
                          </Badge>
                        )}
                        {e.approval_required && e.state !== "filed" && (
                          <Badge variant="outline" className="gap-1 border-zinc-300 text-zinc-700">
                            <ShieldCheck className="h-3 w-3" /> Approval req.
                          </Badge>
                        )}
                      </div>
                    </TableCell>

                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
