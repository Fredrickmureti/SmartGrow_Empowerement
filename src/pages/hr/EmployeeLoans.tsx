/**
 * Employee Loans & Advances — list + dynamic wizard + detail drawer.
 *
 * Wave 1: also surfaces employee-submitted loan requests (status='requested'
 * or 'pending_approval') in a dedicated Approvals card so HR can approve
 * or reject without leaving the page.
 */
import { useEffect, useState } from "react";
import { useDrillDownAnchor } from "@/hooks/useDrillDownAnchor";
import { useEmployeeLoans, type EmployeeLoan } from "@/hooks/useEmployeeLoans";
import { usePermissions } from "@/hooks/usePermissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, DollarSign, TrendingDown, Wallet, Check, X, Inbox } from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { format } from "date-fns";
import { LoanWizard } from "@/components/loans/LoanWizard";
import { LoanDetailDrawer } from "@/components/loans/LoanDetailDrawer";
import { RejectLoanDialog } from "@/components/loans/RejectLoanDialog";
import { toast } from "sonner";

const STATUS_COLORS: Record<string, string> = {
  requested: "bg-blue-500/10 text-blue-600",
  pending_approval: "bg-blue-500/10 text-blue-600",
  rejected: "bg-destructive/10 text-destructive",
  draft: "bg-muted text-muted-foreground",
  active: "bg-primary/10 text-primary",
  completed: "bg-emerald-500/10 text-emerald-600",
  cancelled: "bg-destructive/10 text-destructive",
  suspended: "bg-amber-500/10 text-amber-600",
};

export default function EmployeeLoansPage() {
  const { loans, activeLoans, pendingRequests, isLoading, approveLoan, rejectLoan } = useEmployeeLoans();
  const { can } = usePermissions();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const canManage = can("manageEmployeeLoans");

  const [showWizard, setShowWizard] = useState(false);
  const [detailLoan, setDetailLoan] = useState<EmployeeLoan | null>(null);
  const [rejecting, setRejecting] = useState<EmployeeLoan | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // Phase 4 P4 — honour ?loan={id} from payslip drill-downs: scroll the
  // row into view, briefly highlight it, and pop the detail drawer.
  const { target: loanAnchor, getAnchorProps } = useDrillDownAnchor("loan", {
    ready: !isLoading,
    rowIdPrefix: "loan-row-",
  });
  useEffect(() => {
    if (!loanAnchor || isLoading) return;
    const match = loans.find((l) => l.id === loanAnchor);
    if (match) setDetailLoan(match);
  }, [loanAnchor, isLoading, loans]);

  const totalActive = activeLoans.reduce((s, l) => s + l.outstanding_balance, 0);
  const totalMonthly = activeLoans.reduce((s, l) => s + (l.monthly_deduction || 0), 0);

  const handleApprove = async (loan: EmployeeLoan) => {
    setApprovingId(loan.id);
    try {
      await approveLoan(loan.id);
    } catch (err: any) {
      toast.error(err.message || "Failed to approve loan");
    } finally {
      setApprovingId(null);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Employee Loans & Advances</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Configurable loan types · scheduled recovery · GL-integrated
          </p>
        </div>
        <div className="action-buttons w-full sm:w-auto">
          <ReportExportButtons
            getExportConfig={() => ({
              title: "Employee Loans & Advances",
              companyName: currentOrg?.name || undefined,
              dateRange: `As of ${format(new Date(), "MMM d, yyyy")}`,
              columns: [
                { key: "loan_number", header: "Loan #", width: 14 },
                { key: "employee", header: "Employee", width: 22 },
                { key: "type", header: "Type", width: 16 },
                { key: "method", header: "Method", width: 14 },
                { key: "principal", header: "Principal", format: "currency", width: 14, align: "right" },
                { key: "outstanding", header: "Outstanding", format: "currency", width: 14, align: "right" },
                { key: "status", header: "Status", width: 10 },
              ],
              rows: loans.map((l) => ({
                loan_number: l.loan_number,
                employee: l.employee ? `${l.employee.first_name} ${l.employee.last_name}` : l.employee_id.slice(0, 8),
                type: l.type?.name || l.loan_type,
                method: l.repayment_method,
                principal: l.principal_amount,
                outstanding: l.outstanding_balance,
                status: l.status,
              })),
              organizationId: currentOrg?.id,
              currency: currentBusiness?.base_currency || undefined,
            } as ExportConfig)}
            formats={["excel", "csv", "pdf"]}
            compact
          />
          {canManage && (
            <Button onClick={() => setShowWizard(true)} className="flex-1 sm:flex-none">
              <Plus className="mr-2 h-4 w-4" /> New Loan
            </Button>
          )}
        </div>
      </div>

      <div className="stats-grid grid-cols-1 sm:grid-cols-3">
        <Card><CardHeader className="pb-2">
          <CardDescription>Active Loans</CardDescription>
          <CardTitle className="text-2xl flex items-center gap-1"><Wallet className="h-5 w-5" />{activeLoans.length}</CardTitle>
        </CardHeader></Card>
        <Card><CardHeader className="pb-2">
          <CardDescription>Total Outstanding</CardDescription>
          <CardTitle className="text-2xl flex items-center gap-1"><DollarSign className="h-5 w-5" />{totalActive.toLocaleString(undefined, { minimumFractionDigits: 2 })}</CardTitle>
        </CardHeader></Card>
        <Card><CardHeader className="pb-2">
          <CardDescription>Monthly Recovery</CardDescription>
          <CardTitle className="text-2xl flex items-center gap-1"><TrendingDown className="h-5 w-5" />{totalMonthly.toLocaleString(undefined, { minimumFractionDigits: 2 })}</CardTitle>
        </CardHeader></Card>
      </div>

      {canManage && pendingRequests.length > 0 && (
        <Card className="border-blue-500/30">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-blue-600" />
                  Pending Loan Requests
                </CardTitle>
                <CardDescription>
                  {pendingRequests.length} employee {pendingRequests.length === 1 ? "request" : "requests"} awaiting your decision
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingRequests.map((loan) => (
              <div
                key={loan.id}
                className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 border rounded-lg bg-card hover:bg-muted/30 transition"
              >
                <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setDetailLoan(loan)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm">{loan.loan_number}</span>
                    <Badge variant="outline" className="text-[10px]">{loan.type?.name || loan.loan_type}</Badge>
                    <Badge className={STATUS_COLORS[loan.status]}>{loan.status.replace(/_/g, " ")}</Badge>
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {loan.employee ? `${loan.employee.first_name} ${loan.employee.last_name}` : loan.employee_id.slice(0, 8)}
                    {" · "}
                    <span className="font-mono">{loan.principal_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    {loan.requested_at && ` · requested ${format(new Date(loan.requested_at), "MMM d")}`}
                  </div>
                  {loan.notes && (
                    <div className="text-xs text-muted-foreground mt-1 italic line-clamp-1">"{loan.notes}"</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRejecting(loan)}
                    disabled={approvingId === loan.id}
                  >
                    <X className="h-4 w-4 mr-1" /> Reject
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleApprove(loan)}
                    disabled={approvingId === loan.id}
                  >
                    <Check className="h-4 w-4 mr-1" />
                    {approvingId === loan.id ? "Approving…" : "Approve"}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="md:hidden p-3 space-y-3">
            {loans.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">No loans or advances found</div>
            ) : loans.map((loan) => {
              const anchor = getAnchorProps(loan.id);
              return (
              <button key={loan.id} onClick={() => setDetailLoan(loan)} id={anchor.id} data-anchor={anchor["data-anchor"]} className={`w-full text-left border rounded-lg p-3 space-y-2 hover:bg-muted/50 transition ${anchor.className}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm font-mono">{loan.loan_number}</div>
                    <div className="text-xs text-muted-foreground">
                      {loan.employee ? `${loan.employee.first_name} ${loan.employee.last_name}` : loan.employee_id.slice(0, 8)}
                    </div>
                  </div>
                  <Badge className={STATUS_COLORS[loan.status] || ""}>{loan.status}</Badge>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant="outline" className="text-[10px]">{loan.type?.name || loan.loan_type}</Badge>
                  <span className="text-muted-foreground">{loan.repayment_method.replace(/_/g, " ")}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-muted-foreground text-xs">Principal: </span><span className="font-mono">{loan.principal_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>
                  <div><span className="text-muted-foreground text-xs">Outstanding: </span><span className="font-mono font-medium">{loan.outstanding_balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>
                </div>
              </button>
              );
            })}
          </div>

          <div className="hidden md:block table-container">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Loan #</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loans.map((loan) => {
                  const anchor = getAnchorProps(loan.id);
                  return (
                  <TableRow key={loan.id} id={anchor.id} data-anchor={anchor["data-anchor"]} className={`cursor-pointer hover:bg-muted/50 ${anchor.className}`} onClick={() => setDetailLoan(loan)}>
                    <TableCell className="font-mono text-sm">{loan.loan_number}</TableCell>
                    <TableCell>{loan.employee ? `${loan.employee.first_name} ${loan.employee.last_name}` : loan.employee_id.slice(0, 8)}</TableCell>
                    <TableCell><Badge variant="outline">{loan.type?.name || loan.loan_type}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground capitalize">{loan.repayment_method.replace(/_/g, " ")}</TableCell>
                    <TableCell className="text-right font-mono">{loan.principal_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                    <TableCell className="text-right font-mono">{loan.outstanding_balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                    <TableCell><Badge className={STATUS_COLORS[loan.status] || ""}>{loan.status}</Badge></TableCell>
                  </TableRow>
                  );
                })}
                {loans.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    {isLoading ? "Loading…" : "No loans or advances found"}
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <LoanWizard open={showWizard} onClose={() => setShowWizard(false)} />
      <LoanDetailDrawer loan={detailLoan} open={!!detailLoan} onClose={() => setDetailLoan(null)} />
      <RejectLoanDialog
        open={!!rejecting}
        loanNumber={rejecting?.loan_number || null}
        onClose={() => setRejecting(null)}
        onConfirm={async (reason) => {
          if (rejecting) await rejectLoan(rejecting.id, reason);
        }}
      />
    </div>
  );
}
