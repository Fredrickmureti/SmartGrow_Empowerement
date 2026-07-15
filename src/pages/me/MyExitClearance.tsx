/**
 * MyExitClearance — read-only employee view at /me/exit.
 *
 * Shows the employee any in-flight exit-clearance record so they can track
 * which departments still need to sign off (asset return, IT access,
 * finance settlement, etc.) and see their final-pay status. Item sign-off
 * is performed by the responsible department, not the employee themselves.
 */
import { format, parseISO } from "date-fns";
import { LogOut, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMyExitClearance, type MyExitClearanceItem } from "@/hooks/hr/useMyExitClearance";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

function itemBadge(item: MyExitClearanceItem) {
  if (item.status === "cleared") {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Cleared
      </Badge>
    );
  }
  if (item.is_blocking) {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="h-3 w-3" />
        Blocking
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Clock className="h-3 w-3" />
      Pending
    </Badge>
  );
}

export default function MyExitClearance() {
  const { clearances, isLoading } = useMyExitClearance();

  if (isLoading) {
    return (
      <>
        <PageHeader title="My exit clearance" description="Progress on the clearance items each department must sign off before your final payslip can be released." />
        <PageBody><LoadingState /></PageBody>
      </>
    );
  }

  if (clearances.length === 0) {
    return (
      <>
        <PageHeader title="My exit clearance" description="Track your departure sign-offs from each department." />
        <PageBody>
          <EmptyState icon={LogOut} title="No active exit-clearance record" description="If you believe this is wrong, please contact HR." />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="My exit clearance"
        description="Progress on the clearance items each department must sign off before your final payslip can be released."
      />
      <PageBody>
      {clearances.map((c) => {
        const total = c.items.length;
        const cleared = c.items.filter((i) => i.status === "cleared").length;
        const pct = total === 0 ? 0 : Math.round((cleared / total) * 100);
        return (
          <Card key={c.id}>
            <CardHeader>
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="capitalize">{c.exit_type} — {c.status.replace(/_/g, " ")}</CardTitle>
                  <CardDescription>
                    Last working day: <strong>{format(parseISO(c.last_working_day), "d MMM yyyy")}</strong>
                    {" "}· Initiated {format(parseISO(c.initiated_at), "d MMM yyyy")}
                    {c.completed_at && <> · Completed {format(parseISO(c.completed_at), "d MMM yyyy")}</>}
                  </CardDescription>
                </div>
                <div className="text-right min-w-[180px]">
                  <div className="text-sm text-muted-foreground">{cleared} of {total} items cleared</div>
                  <Progress value={pct} className="h-2 mt-1" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {c.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No clearance items defined.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Department</TableHead>
                      <TableHead>Task</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Signed</TableHead>
                      <TableHead>Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">{item.department}</TableCell>
                        <TableCell>{item.task}</TableCell>
                        <TableCell>{itemBadge(item)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {item.signed_at ? format(parseISO(item.signed_at), "d MMM yyyy") : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {item.notes || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        );
      })}
      </PageBody>
    </>
  );
}