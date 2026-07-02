import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSalespersonDashboard } from "@/hooks/useSalespersonDashboard";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Users,
  DollarSign,
  ShoppingCart,
  FileText,
  CreditCard,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";

export default function SalespersonPerformance() {
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(now), "yyyy-MM-dd"));

  const { metrics, isLoading, refetch } = useSalespersonDashboard({
    dateFrom,
    dateTo,
  });

  const { formatCurrency, baseCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { getUserName } = useOrgMembers();
  const navigate = useNavigate();

  // Summary totals
  const totals = metrics.reduce(
    (acc, m) => ({
      totalSales: acc.totalSales + m.total_sales,
      totalOrders: acc.totalOrders + m.total_orders,
      totalInvoices: acc.totalInvoices + m.invoices_generated,
      totalCash: acc.totalCash + m.cash_collected,
      totalCredit: acc.totalCredit + m.credit_issued,
      totalOutstanding: acc.totalOutstanding + m.outstanding_receivables,
    }),
    { totalSales: 0, totalOrders: 0, totalInvoices: 0, totalCash: 0, totalCredit: 0, totalOutstanding: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Salesperson Performance</h1>
          <p className="text-muted-foreground">Track sales, collections, and credit by team member</p>
        </div>
        <div className="flex items-center gap-2">
          <ReportExportButtons
            compact
            formats={["excel", "csv", "print", "pdf"]}
            getExportConfig={() => {
              const cols: ExportColumn[] = [
                { key: "salesperson", header: "Salesperson", width: 22 },
                { key: "total_sales", header: "Total Sales", format: "currency", width: 14, align: "right" },
                { key: "total_orders", header: "POS Orders", width: 12, align: "right" },
                { key: "invoices", header: "Invoices", width: 12, align: "right" },
                { key: "cash", header: "Cash Collected", format: "currency", width: 14, align: "right" },
                { key: "credit", header: "Credit Issued", format: "currency", width: 14, align: "right" },
                { key: "outstanding", header: "Outstanding", format: "currency", width: 14, align: "right" },
              ];
              const rows = metrics.map((m) => ({
                salesperson: getUserName(m.user_id) || m.user_email,
                total_sales: m.total_sales,
                total_orders: m.total_orders,
                invoices: m.invoices_generated,
                cash: m.cash_collected,
                credit: m.credit_issued,
                outstanding: m.outstanding_receivables,
              }));
              return {
                title: `Salesperson Performance (${dateFrom} to ${dateTo})`,
                columns: cols,
                rows,
                currency: baseCurrency,
                companyName: currentOrg?.name,
                organizationId: currentOrg?.id,
              } as ExportConfig;
            }}
          />
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Date filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex gap-4 items-end">
            <div className="space-y-1">
              <Label>From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-4 w-4" /> Total Sales
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{formatCurrency(totals.totalSales)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <ShoppingCart className="h-4 w-4" /> POS Orders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{totals.totalOrders}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <FileText className="h-4 w-4" /> Invoices
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{totals.totalInvoices}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <CreditCard className="h-4 w-4" /> Cash Collected
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{formatCurrency(totals.totalCash)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Users className="h-4 w-4" /> Credit Issued
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">{formatCurrency(totals.totalCredit)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> Outstanding
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">{formatCurrency(totals.totalOutstanding)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Per-salesperson table */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Salesperson</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground py-8 text-center">Loading...</p>
          ) : metrics.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center">No sales data for the selected period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Total Sales</TableHead>
                  <TableHead className="text-right">POS Orders</TableHead>
                  <TableHead className="text-right">Invoices</TableHead>
                  <TableHead className="text-right">Cash Collected</TableHead>
                  <TableHead className="text-right">Credit Issued</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.map((m) => (
                  <TableRow
                    key={m.user_id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => navigate(`/sales/invoices?salesperson=${m.user_id}`)}
                  >
                    <TableCell className="font-medium">
                      {getUserName(m.user_id) || m.user_email}
                    </TableCell>
                    <TableCell className="text-right">{formatCurrency(m.total_sales)}</TableCell>
                    <TableCell className="text-right">{m.total_orders}</TableCell>
                    <TableCell className="text-right">{m.invoices_generated}</TableCell>
                    <TableCell className="text-right">{formatCurrency(m.cash_collected)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(m.credit_issued)}</TableCell>
                    <TableCell className="text-right text-destructive font-medium">
                      {formatCurrency(m.outstanding_receivables)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
