import { useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useSalespersonDashboard,
  useSalespersonDocuments,
  type SalespersonMetricKey,
} from "@/hooks/useSalespersonDashboard";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DollarSign,
  ShoppingCart,
  FileText,
  CreditCard,
  AlertTriangle,
  RefreshCw,
  FileMinus,
  Wallet,
  Info,
} from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";

/** Each metric has its own event date; the range means different things per column. */
const METRIC_BASIS: Record<SalespersonMetricKey, string> = {
  revenue: "Invoice issue date",
  credit: "Credit note issue date",
  cash: "Payment date",
  outstanding: "Open position as of today (not date-filtered)",
  orders: "Order date",
  pos: "Transaction date",
};

const METRIC_LABEL: Record<SalespersonMetricKey, string> = {
  revenue: "Gross invoiced",
  credit: "Credit notes",
  cash: "Cash collected",
  outstanding: "Outstanding",
  orders: "Orders booked",
  pos: "POS (uninvoiced)",
};

export default function SalespersonPerformance() {
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(endOfMonth(now), "yyyy-MM-dd"));
  const [drill, setDrill] = useState<{
    salespersonId: string;
    name: string;
    metric: SalespersonMetricKey;
  } | null>(null);

  const { metrics, isLoading, error, refetch } = useSalespersonDashboard({ dateFrom, dateTo });
  const { formatCurrency, baseCurrency } = useCurrency();
  const { currentOrg } = useOrganization();

  const documents = useSalespersonDocuments({
    salespersonId: drill?.salespersonId ?? null,
    metric: drill?.metric ?? null,
    dateFrom,
    dateTo,
  });

  const totals = metrics.reduce(
    (acc, m) => ({
      gross: acc.gross + m.gross_invoiced,
      credit: acc.credit + m.credit_notes_value,
      net: acc.net + m.net_revenue,
      invoices: acc.invoices + m.invoice_count,
      orders: acc.orders + m.orders_booked,
      cash: acc.cash + m.cash_collected,
      outstanding: acc.outstanding + m.outstanding,
      overdue: acc.overdue + m.overdue_amount,
      pos: acc.pos + m.pos_sales_value,
    }),
    { gross: 0, credit: 0, net: 0, invoices: 0, orders: 0, cash: 0, outstanding: 0, overdue: 0, pos: 0 },
  );

  const hasForeignCurrency = metrics.some((m) => m.has_foreign_currency);

  const openDrill = (salespersonId: string, name: string, metric: SalespersonMetricKey) =>
    setDrill({ salespersonId, name, metric });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Salesperson Performance</h1>
          <p className="text-muted-foreground">
            Net revenue, collections and receivables attributed to the salesperson who owns each document
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ReportExportButtons
            compact
            formats={["excel", "csv", "print", "pdf"]}
            getExportConfig={() => {
              const cols: ExportColumn[] = [
                { key: "salesperson", header: "Salesperson", width: 22 },
                { key: "gross", header: "Gross invoiced", format: "currency", width: 15, align: "right" },
                { key: "credit", header: "Credit notes", format: "currency", width: 14, align: "right" },
                { key: "net", header: "Net revenue", format: "currency", width: 15, align: "right" },
                { key: "invoices", header: "Invoices", width: 10, align: "right" },
                { key: "orders", header: "Orders", width: 10, align: "right" },
                { key: "cash", header: "Cash collected", format: "currency", width: 15, align: "right" },
                { key: "outstanding", header: "Outstanding", format: "currency", width: 14, align: "right" },
                { key: "overdue", header: "Overdue", format: "currency", width: 14, align: "right" },
                { key: "pos", header: "POS (uninvoiced)", format: "currency", width: 15, align: "right" },
              ];
              const rows = metrics.map((m) => ({
                salesperson: m.salesperson_name,
                gross: m.gross_invoiced,
                credit: m.credit_notes_value,
                net: m.net_revenue,
                invoices: m.invoice_count,
                orders: m.orders_booked,
                cash: m.cash_collected,
                outstanding: m.outstanding,
                overdue: m.overdue_amount,
                pos: m.pos_sales_value,
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

      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-1">
              <Label>From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1 pb-2">
              <Info className="h-3.5 w-3.5" />
              Revenue uses invoice date, cash uses payment date, receivables are the position as of today.
            </p>
          </div>
        </CardContent>
      </Card>

      {hasForeignCurrency && (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Some documents in this period are in a foreign currency. Amounts are shown converted to{" "}
          {baseCurrency} at each document's recorded exchange rate.
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            Could not load performance data: {error.message}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-4 w-4" /> Net revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-foreground tabular-nums whitespace-nowrap">{formatCurrency(totals.net)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {formatCurrency(totals.gross)} invoiced − {formatCurrency(totals.credit)} credited
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <FileText className="h-4 w-4" /> Invoices
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-foreground tabular-nums whitespace-nowrap">{totals.invoices}</p>
            <p className="text-xs text-muted-foreground mt-1">Posted only — drafts excluded</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <ShoppingCart className="h-4 w-4" /> Orders booked
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-foreground tabular-nums whitespace-nowrap">{totals.orders}</p>
            <p className="text-xs text-muted-foreground mt-1">{formatCurrency(0 + metrics.reduce((s, m) => s + m.orders_value, 0))}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <CreditCard className="h-4 w-4" /> Cash collected
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-foreground tabular-nums whitespace-nowrap">{formatCurrency(totals.cash)}</p>
            <p className="text-xs text-muted-foreground mt-1">Allocated to their invoices</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <FileMinus className="h-4 w-4" /> Credit notes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-foreground tabular-nums whitespace-nowrap">{formatCurrency(totals.credit)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> Outstanding
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-destructive tabular-nums whitespace-nowrap">{formatCurrency(totals.outstanding)}</p>
            <p className="text-xs text-muted-foreground mt-1">{formatCurrency(totals.overdue)} overdue</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Wallet className="h-4 w-4" /> POS (uninvoiced)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-foreground tabular-nums whitespace-nowrap">{formatCurrency(totals.pos)}</p>
            <p className="text-xs text-muted-foreground mt-1">Excluded from revenue to avoid double counting</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance by salesperson</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground py-8 text-center">Loading...</p>
          ) : metrics.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center">No sales activity for the selected period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Gross invoiced</TableHead>
                  <TableHead className="text-right">Credit notes</TableHead>
                  <TableHead className="text-right">Net revenue</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Cash collected</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">POS (uninvoiced)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.map((m) => (
                  <TableRow key={m.salesperson_id}>
                    <TableCell className="font-medium">{m.salesperson_name}</TableCell>
                    <TableCell
                      className="text-right cursor-pointer hover:underline"
                      onClick={() => openDrill(m.salesperson_id, m.salesperson_name, "revenue")}
                    >
                      {formatCurrency(m.gross_invoiced)}
                      <span className="block text-xs text-muted-foreground">{m.invoice_count} invoices</span>
                    </TableCell>
                    <TableCell
                      className="text-right cursor-pointer hover:underline"
                      onClick={() => openDrill(m.salesperson_id, m.salesperson_name, "credit")}
                    >
                      {formatCurrency(m.credit_notes_value)}
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(m.net_revenue)}</TableCell>
                    <TableCell
                      className="text-right cursor-pointer hover:underline"
                      onClick={() => openDrill(m.salesperson_id, m.salesperson_name, "orders")}
                    >
                      {m.orders_booked}
                      <span className="block text-xs text-muted-foreground">{formatCurrency(m.orders_value)}</span>
                    </TableCell>
                    <TableCell
                      className="text-right cursor-pointer hover:underline"
                      onClick={() => openDrill(m.salesperson_id, m.salesperson_name, "cash")}
                    >
                      {formatCurrency(m.cash_collected)}
                    </TableCell>
                    <TableCell
                      className="text-right text-destructive font-medium cursor-pointer hover:underline"
                      onClick={() => openDrill(m.salesperson_id, m.salesperson_name, "outstanding")}
                    >
                      {formatCurrency(m.outstanding)}
                      <span className="block text-xs text-muted-foreground">
                        {formatCurrency(m.overdue_amount)} overdue
                      </span>
                    </TableCell>
                    <TableCell
                      className="text-right cursor-pointer hover:underline"
                      onClick={() => openDrill(m.salesperson_id, m.salesperson_name, "pos")}
                    >
                      {formatCurrency(m.pos_sales_value)}
                      <span className="block text-xs text-muted-foreground">{m.pos_sales_count} sales</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!drill} onOpenChange={(open) => !open && setDrill(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {drill ? `${METRIC_LABEL[drill.metric]} — ${drill.name}` : ""}
            </DialogTitle>
            <DialogDescription>
              {drill ? METRIC_BASIS[drill.metric] : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {documents.isLoading ? (
              <p className="text-muted-foreground py-8 text-center">Loading documents...</p>
            ) : (documents.data ?? []).length === 0 ? (
              <p className="text-muted-foreground py-8 text-center">No source documents for this figure.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(documents.data ?? []).map((d) => (
                    <TableRow key={`${d.document_kind}-${d.document_id}`}>
                      <TableCell className="font-medium">{d.document_number ?? "—"}</TableCell>
                      <TableCell>{d.document_date ?? "—"}</TableCell>
                      <TableCell>{d.contact_name ?? "—"}</TableCell>
                      <TableCell className="capitalize">{d.status ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(d.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
