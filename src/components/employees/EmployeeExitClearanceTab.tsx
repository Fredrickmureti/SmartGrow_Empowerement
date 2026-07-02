/**
 * Employee Exit Clearance tab — surfaces the current/most-recent clearance
 * record and its department-by-department signoff status. Read-only here;
 * full management happens inside the Termination dialog.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, Circle, Lock, LogOut, ShieldAlert } from "lucide-react";
import { format } from "date-fns";
import { useEmployeeBlockers, useExitClearance } from "@/hooks/useExitClearance";
import { useCurrency } from "@/hooks/useCurrency";
import { useMemo } from "react";

export function EmployeeExitClearanceTab({ employeeId }: { employeeId: string }) {
  const { formatCurrency } = useCurrency();
  const { clearance, items, loading, allBlockingSigned } = useExitClearance(employeeId);
  const { blockers } = useEmployeeBlockers(employeeId);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof items>();
    items.forEach((i) => {
      if (!m.has(i.department)) m.set(i.department, []);
      m.get(i.department)!.push(i);
    });
    return Array.from(m.entries());
  }, [items]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Exit Clearance</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {(blockers.outstandingLoans > 0 || blockers.assignedAssets > 0) && (
        <Alert variant={clearance ? "destructive" : "default"}>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Open obligations</AlertTitle>
          <AlertDescription className="space-y-1 text-sm">
            {blockers.outstandingLoans > 0 && (
              <div>
                {blockers.outstandingLoans} active loan(s) · outstanding{" "}
                <strong>{formatCurrency(blockers.outstandingLoanBalance)}</strong>
              </div>
            )}
            {blockers.assignedAssets > 0 && (
              <div>{blockers.assignedAssets} company asset(s) not yet returned</div>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <LogOut className="h-4 w-4" /> Exit Clearance
            </CardTitle>
            {clearance ? (
              <p className="text-xs text-muted-foreground mt-1">
                Initiated {format(new Date(clearance.initiated_at), "MMM d, yyyy")} ·
                Last working day {format(new Date(clearance.last_working_day), "MMM d, yyyy")} ·
                Type {clearance.exit_type.replace(/_/g, " ")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                No clearance initiated. Use the Termination dialog from the directory
                to start offboarding.
              </p>
            )}
          </div>
          {clearance && (
            <Badge
              variant={
                clearance.status === "completed"
                  ? "default"
                  : clearance.status === "cancelled"
                  ? "secondary"
                  : allBlockingSigned
                  ? "default"
                  : "outline"
              }
            >
              {clearance.status === "completed"
                ? "Completed"
                : clearance.status === "cancelled"
                ? "Cancelled"
                : allBlockingSigned
                ? "Ready to close"
                : "In progress"}
            </Badge>
          )}
        </CardHeader>
        {clearance && (
          <CardContent>
            <div className="space-y-4">
              {grouped.map(([dept, rows]) => (
                <div key={dept} className="rounded-md border p-3">
                  <div className="mb-2 text-sm font-semibold">{dept}</div>
                  <div className="space-y-2">
                    {rows.map((item) => {
                      const done =
                        item.status === "completed" || item.status === "waived";
                      return (
                        <div key={item.id} className="flex items-start gap-2 text-sm">
                          {done ? (
                            <CheckCircle2 className="h-4 w-4 text-primary mt-0.5" />
                          ) : (
                            <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />
                          )}
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span
                                className={done ? "line-through text-muted-foreground" : ""}
                              >
                                {item.task}
                              </span>
                              {item.is_blocking && (
                                <Lock className="h-3 w-3 text-muted-foreground" />
                              )}
                              {item.status === "waived" && (
                                <Badge variant="outline">Waived</Badge>
                              )}
                            </div>
                            {item.notes && (
                              <p className="text-xs text-muted-foreground">
                                {item.notes}
                              </p>
                            )}
                            {item.signed_at && (
                              <p className="text-xs text-muted-foreground">
                                Signed{" "}
                                {format(new Date(item.signed_at), "MMM d, yyyy HH:mm")}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
