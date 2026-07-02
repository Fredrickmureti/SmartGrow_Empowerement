import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Loader2, FileText, Eye } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { PayslipDetailDialog } from "@/components/payroll/PayslipDetailDialog";
import { usePermissions } from "@/hooks/usePermissions";

interface EmployeePayslipHistoryProps {
  employeeId: string;
}

export function EmployeePayslipHistory({ employeeId }: EmployeePayslipHistoryProps) {
  const { formatCurrency } = useCurrency();
  const { can } = usePermissions();
  const canSeeAmounts = can("viewSalaryDetails");
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data: payslips = [], isLoading } = useQuery({
    queryKey: ["employee-payslips", employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payslips")
        .select("*, payroll_runs!inner(payroll_number, pay_period_start, pay_period_end, payment_date)")
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    enabled: !!employeeId,
  });

  const handleDownloadPayslip = async (ps: any) => {
    try {
      const run = ps.payroll_runs;
      const { data, error } = await supabase.functions.invoke("generate-payslip-pdf", {
        body: { payslip_id: ps.id },
      });
      if (error) throw error;
      const blob = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Payslip_${run.payroll_number}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch {
      toast.error("Failed to generate payslip PDF");
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (payslips.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-8 text-center">
          <FileText className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-muted-foreground">No payslips found for this employee.</p>
        </CardContent>
      </Card>
    );
  }

  const getExportConfig = (): ExportConfig => ({
    title: "Payslip History",
    columns: [
      { key: "period", header: "Period", width: 25 },
      { key: "payroll_number", header: "Payroll #", width: 15 },
      { key: "gross_pay", header: "Gross Pay", format: "currency", align: "right" },
      { key: "total_deductions", header: "Deductions", format: "currency", align: "right" },
      { key: "net_pay", header: "Net Pay", format: "currency", align: "right" },
      { key: "status", header: "Status", width: 10 },
    ],
    rows: payslips.map((ps: any) => {
      const run = ps.payroll_runs;
      return {
        period: `${format(new Date(run.pay_period_start), "MMM d")} - ${format(new Date(run.pay_period_end), "MMM d, yyyy")}`,
        payroll_number: run.payroll_number,
        gross_pay: ps.gross_pay,
        total_deductions: ps.total_deductions,
        net_pay: ps.net_pay,
        status: ps.status,
      };
    }),
    sheetName: "Payslip History",
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">Payslip History</CardTitle>
        {payslips.length > 0 && (
          <ReportExportButtons
            compact
            formats={["excel", "csv", "pdf"]}
            getExportConfig={getExportConfig}
          />
        )}
      </CardHeader>
      <CardContent>
        {/* Mobile cards */}
        <div className="space-y-3 sm:hidden">
          {payslips.map((ps: any) => {
            const run = ps.payroll_runs;
            return (
              <div key={ps.id} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{run.payroll_number}</span>
                  <Badge className={ps.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-yellow-100 text-yellow-800"}>
                    {ps.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {format(new Date(run.pay_period_start), "MMM d")} - {format(new Date(run.pay_period_end), "MMM d, yyyy")}
                </p>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs">Gross</p>
                    <p className="font-medium">{formatCurrency(ps.gross_pay)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Deductions</p>
                    <p className="font-medium">{formatCurrency(ps.total_deductions)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Net</p>
                    <p className="font-bold">{formatCurrency(ps.net_pay)}</p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="w-full" onClick={() => handleDownloadPayslip(ps)}>
                  <Download className="h-3 w-3 mr-1" /> Download PDF
                </Button>
                <Button variant="outline" size="sm" className="w-full" onClick={() => setDetailId(ps.id)}>
                  <Eye className="h-3 w-3 mr-1" /> View detail
                </Button>
              </div>
            );
          })}
        </div>

        {/* Desktop table */}
        <div className="hidden sm:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Payroll #</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Deductions</TableHead>
                <TableHead className="text-right font-bold">Net Pay</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payslips.map((ps: any) => {
                const run = ps.payroll_runs;
                return (
                  <TableRow key={ps.id}>
                    <TableCell className="text-sm">
                      {format(new Date(run.pay_period_start), "MMM d")} - {format(new Date(run.pay_period_end), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="font-medium">{run.payroll_number}</TableCell>
                    <TableCell className="text-right">{formatCurrency(ps.gross_pay)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(ps.total_deductions)}</TableCell>
                    <TableCell className="text-right font-bold">{formatCurrency(ps.net_pay)}</TableCell>
                    <TableCell>
                      <Badge className={ps.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-yellow-100 text-yellow-800"}>
                        {ps.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" title="View detail" onClick={() => setDetailId(ps.id)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Download PDF" onClick={() => handleDownloadPayslip(ps)}>
                        <Download className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <PayslipDetailDialog
        payslipId={detailId}
        open={!!detailId}
        onOpenChange={(v) => !v && setDetailId(null)}
        canSeeAmounts={canSeeAmounts}
      />
    </Card>
  );
}
