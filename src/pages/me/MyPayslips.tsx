/**
 * MyPayslips — employee self-service payslip surface at /me/payslips.
 *
 * Purpose-built portal page (mirrors MyLoans / MyDocuments shape). Replaces
 * the legacy EmployeeSelfService payslip tab. NEVER renders admin
 * affordances such as "Add me as an employee" — when the user has no
 * employee record, the shared <EmployeeLinkRequired/> empty state is
 * rendered and the (admin-only) self-link CTA is decided server-side.
 */
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Download, Eye, FileText, Loader2 } from "lucide-react";
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
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { PageHeader, PageBody } from "@/design-system";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { PayslipDetailDialog } from "@/components/payroll/PayslipDetailDialog";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";
import type { Payslip } from "@/hooks/usePayroll";

interface PayslipWithRun extends Payslip {
  payroll_run?: {
    id: string;
    payroll_number: string;
    pay_period_start: string;
    pay_period_end: string;
    status: string;
  };
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  approved: "bg-green-500/10 text-green-600 border-green-500/20",
  rejected: "bg-red-500/10 text-red-600 border-red-500/20",
  paid: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  draft: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STATUS_STYLE[status] ?? ""}>
      {status}
    </Badge>
  );
}

export default function MyPayslips() {
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const { currentOrg } = useOrganization();
  const { formatCurrency } = useCurrency();
  const [payslips, setPayslips] = useState<PayslipWithRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [detailPayslip, setDetailPayslip] = useState<PayslipWithRun | null>(null);


  useEffect(() => {
    if (!currentEmployee?.id) {
      setPayslips([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("payslips")
          .select(
            `*, employee:employees(id, first_name, last_name, employee_number),
             payroll_run:payroll_runs(id, payroll_number, pay_period_start, pay_period_end, status)`,
          )
          .eq("employee_id", currentEmployee.id)
          .order("created_at", { ascending: false });
        if (error) throw error;
        setPayslips((data || []) as unknown as PayslipWithRun[]);
      } catch (err) {
        console.error("[MyPayslips] fetch failed:", err);
        toast.error("Couldn't load your payslips.");
      } finally {
        setIsLoading(false);
      }
    })();
  }, [currentEmployee?.id]);

  const handleDownload = async (ps: PayslipWithRun) => {
    try {
      const { data, error } = await supabase.functions.invoke("generate-payslip-pdf", {
        body: { payslip_id: ps.id },
      });
      if (error) throw error;
      const blob = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const empName = `${currentEmployee?.first_name}_${currentEmployee?.last_name}`;
      link.download = `${empName}_${ps.payroll_run?.payroll_number || "payslip"}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (err) {
      console.error("[MyPayslips] PDF error:", err);
      toast.error("Failed to generate PDF");
    }
  };

  const exportConfig = useMemo<() => ExportConfig>(
    () => () => ({
      title: "My Payslip History",
      subtitle: currentEmployee
        ? `${currentEmployee.first_name} ${currentEmployee.last_name} (${currentEmployee.employee_number})`
        : "",
      companyName: currentOrg?.name || "",
      columns: [
        { key: "period", header: "Period", width: 25 },
        { key: "payroll_number", header: "Payroll #", width: 15 },
        { key: "gross_pay", header: "Gross Pay", width: 15, format: "currency", align: "right" },
        { key: "total_deductions", header: "Deductions", width: 15, format: "currency", align: "right" },
        { key: "net_pay", header: "Net Pay", width: 15, format: "currency", align: "right" },
        { key: "status", header: "Status", width: 12 },
      ],
      rows: payslips.map((ps) => ({
        period: ps.payroll_run
          ? `${format(new Date(ps.payroll_run.pay_period_start), "MMM d")} - ${format(
              new Date(ps.payroll_run.pay_period_end),
              "MMM d, yyyy",
            )}`
          // Defensive: if the payroll_run join is filtered out by RLS, fall
          // back to the payslip's own identifier rather than emitting a blank
          // "Period" cell in the exported document.
          : (ps as any).payslip_number || "—",
        payroll_number: ps.payroll_run?.payroll_number || (ps as any).payslip_number || "—",
        gross_pay: ps.gross_pay,
        total_deductions: ps.total_deductions,
        net_pay: ps.net_pay,
        status: ps.status,
      })),
      sheetName: "Payslips",
    }),
    [payslips, currentEmployee, currentOrg?.name],
  );

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
    <>
      <PageHeader
        title="My payslips"
        description="Download recent pay statements and review your earnings history."
        actions={
          payslips.length > 0 ? (
            <ReportExportButtons getExportConfig={exportConfig} compact hideEmail />
          ) : null
        }
      />
      <PageBody>
        <Card>
        <CardHeader>
          <CardTitle className="text-base">Payslip history</CardTitle>
          <CardDescription>
            Your processed payslips, most recent first. Click the eye icon to see line-item
            detail or the download icon for a PDF copy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : payslips.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground text-sm">
              No payslips yet. They will appear here after payroll is processed.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Payroll #</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Deductions</TableHead>
                    <TableHead className="text-right">Net pay</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payslips.map((ps) => (
                    <TableRow key={ps.id}>
                      <TableCell className="text-sm">
                        {ps.payroll_run
                          ? `${format(new Date(ps.payroll_run.pay_period_start), "MMM d")} - ${format(
                              new Date(ps.payroll_run.pay_period_end),
                              "MMM d, yyyy",
                            )}`
                          : "—"}
                      </TableCell>
                      <TableCell className="font-medium">
                        {ps.payroll_run?.payroll_number || "—"}
                      </TableCell>
                      <TableCell className="text-right">{formatCurrency(ps.gross_pay)}</TableCell>
                      <TableCell className="text-right text-destructive">
                        ({formatCurrency(ps.total_deductions)})
                      </TableCell>
                      <TableCell className="text-right font-bold">
                        {formatCurrency(ps.net_pay)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={ps.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="View detail"
                          onClick={() => setDetailPayslip(ps)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Download PDF"
                          onClick={() => handleDownload(ps)}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <PayslipDetailDialog
        payslipId={detailPayslip?.id ?? null}
        open={!!detailPayslip}
        onOpenChange={(v) => !v && setDetailPayslip(null)}
        canSeeAmounts
        portalMode
        payslip={detailPayslip}
        currency={(currentOrg as { currency_code?: string } | null | undefined)?.currency_code}
        title="Payslip detail"
      />
      </PageBody>
    </>
  );
}

