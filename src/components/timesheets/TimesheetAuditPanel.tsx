/**
 * TimesheetAuditPanel — collapsible audit trail for a submission.
 * Reads from timesheet_audit_log via useTimesheetAudit.
 */
import { format } from "date-fns";
import { History } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTimesheetAudit } from "@/hooks/timesheets";

interface Props {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
}

const ACTION_LABEL: Record<string, string> = {
  created: "Created",
  status_change: "Status changed",
  payroll_locked: "Locked by payroll",
  payroll_unlocked: "Unlocked by payroll",
  invoiced: "Invoiced",
  invoice_reverted: "Invoice reverted",
};

export function TimesheetAuditPanel({ employeeId, periodStart, periodEnd }: Props) {
  const { rows, isLoading } = useTimesheetAudit(employeeId, periodStart, periodEnd);
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs">
          <History className="h-3 w-3 mr-1" /> View audit trail ({rows.length})
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md border bg-muted/30 p-3 max-h-64 overflow-auto">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No audit events yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.id} className="text-xs flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {ACTION_LABEL[r.action] || r.action}
                </Badge>
                <span className="text-muted-foreground">
                  {format(new Date(r.created_at), "MMM d, HH:mm")}
                </span>
                {r.from_status && r.to_status && (
                  <span className="font-mono">
                    {r.from_status} → {r.to_status}
                  </span>
                )}
                {r.metadata?.rejection_reason && (
                  <span className="italic text-destructive">"{r.metadata.rejection_reason}"</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
