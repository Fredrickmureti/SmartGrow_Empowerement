/**
 * MyLoans — employee self-service for loans & advances at /me/loans.
 *
 * Shows the signed-in employee their own loans grouped by lifecycle stage
 * (Pending requests, Active, History) and lets them open a slim
 * `RequestLoanWizard` to submit new requests. All reads/writes go through
 * the `useMyLoans` hook which relies on RLS to scope rows.
 */
import { useState } from "react";
import { useDrillDownAnchor } from "@/hooks/payroll/useDrillDownAnchor";
import { format } from "date-fns";
import { Plus, Wallet, TrendingDown, Clock, History, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyLoans } from "@/hooks/useMyLoans";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";
import { RequestLoanWizard } from "@/components/loans/RequestLoanWizard";
import type { EmployeeLoan } from "@/hooks/useEmployeeLoans";

const STATUS_LABEL: Record<string, string> = {
  requested: "Awaiting HR review",
  pending_approval: "Pending approval",
  rejected: "Rejected",
  draft: "Draft",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
  suspended: "Suspended",
};

const STATUS_STYLE: Record<string, string> = {
  requested: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  pending_approval: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  active: "bg-primary/10 text-primary border-primary/20",
  completed: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  rejected: "bg-destructive/10 text-destructive border-destructive/20",
  cancelled: "bg-muted text-muted-foreground",
  suspended: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  draft: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STATUS_STYLE[status] ?? ""}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export default function MyLoans() {
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const { loans, pendingRequests, activeLoans, history, isLoading, cancelRequest } = useMyLoans();
  const { formatCurrency } = useCurrency();
  const [showWizard, setShowWizard] = useState(false);

  const totalOutstanding = activeLoans.reduce((s, l) => s + Number(l.outstanding_balance || 0), 0);
  const monthlyDeduction = activeLoans.reduce((s, l) => s + Number(l.monthly_deduction || 0), 0);

  if (empLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto space-y-4">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!currentEmployee) {
    return <EmployeeLinkRequired />;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">My loans & advances</h1>
          <p className="text-sm text-muted-foreground">
            Request a salary advance or staff loan, and track repayments.
          </p>
        </div>
        <Button onClick={() => setShowWizard(true)}>
          <Plus className="h-4 w-4 mr-2" /> Request loan
        </Button>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Active loans</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeLoans.length}</div>
            <p className="text-xs text-muted-foreground">
              Outstanding: {formatCurrency(totalOutstanding)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Monthly deduction</CardTitle>
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(monthlyDeduction)}</div>
            <p className="text-xs text-muted-foreground">Across active loans</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Pending requests</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingRequests.length}</div>
            <p className="text-xs text-muted-foreground">Awaiting HR</p>
          </CardContent>
        </Card>
      </div>

      {/* Pending */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending requests</CardTitle>
          <CardDescription>
            Requests you have submitted that are still being reviewed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : pendingRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No pending requests.
            </p>
          ) : (
            <LoanTable
              rows={pendingRequests}
              showCancel
              onCancel={(id) => cancelRequest.mutate(id)}
            />
          )}
        </CardContent>
      </Card>

      {/* Active */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active loans</CardTitle>
          <CardDescription>Currently being repaid through payroll.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : activeLoans.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No active loans.
            </p>
          ) : (
            <LoanTable rows={activeLoans} />
          )}
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Nothing in history yet.
            </p>
          ) : (
            <LoanTable rows={history} />
          )}
        </CardContent>
      </Card>

      <RequestLoanWizard open={showWizard} onClose={() => setShowWizard(false)} />
    </div>
  );
}

function LoanTable({
  rows,
  showCancel,
  onCancel,
}: {
  rows: EmployeeLoan[];
  showCancel?: boolean;
  onCancel?: (id: string) => void;
}) {
  const { formatCurrency } = useCurrency();
  // Phase 4 P4 — destination of `/me/loans?loan=…` drill-downs.
  const { getAnchorProps } = useDrillDownAnchor("loan", { rowIdPrefix: "loan-row-" });
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Loan #</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Principal</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead className="text-right">Monthly</TableHead>
            <TableHead>Submitted</TableHead>
            <TableHead>Status</TableHead>
            {showCancel && <TableHead></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((l) => {
            const anchor = getAnchorProps(l.id);
            return (
            <TableRow key={l.id} id={anchor.id} data-anchor={anchor["data-anchor"]} className={anchor.className}>
              <TableCell className="font-medium">{l.loan_number}</TableCell>
              <TableCell>{l.type?.name ?? l.loan_type}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(Number(l.principal_amount))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(Number(l.outstanding_balance))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(Number(l.monthly_deduction))}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {l.requested_at
                  ? format(new Date(l.requested_at), "MMM d, yyyy")
                  : format(new Date(l.created_at), "MMM d, yyyy")}
              </TableCell>
              <TableCell>
                <StatusBadge status={l.status} />
                {l.status === "rejected" && (l as any).rejection_reason && (
                  <p className="text-xs text-muted-foreground mt-1 max-w-[18rem]">
                    {(l as any).rejection_reason}
                  </p>
                )}
              </TableCell>
              {showCancel && (
                <TableCell>
                  {l.status === "requested" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onCancel?.(l.id)}
                      title="Cancel request"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
