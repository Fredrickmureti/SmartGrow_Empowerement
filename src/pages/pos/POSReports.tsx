import { useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePOSReports } from "@/hooks/pos/usePOSReports";
import {
  usePOSTransactionHistory,
  type POSTransactionRecord,
} from "@/hooks/pos/usePOSTransactionHistory";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { usePOSEnhancedReports } from "@/hooks/pos/usePOSEnhancedReports";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReceiptPreviewBody } from "@/components/pos/ReceiptPreviewBody";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { dispatchPosReceipt } from "@/features/pos/receipts/dispatchPosReceipt";
import { toast } from "sonner";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import {
  exportToCSV,
  exportToExcel,
  exportToPDF,
} from "@/services/reports/ReportExportService";
import type {
  ExportConfig,
  ExportColumn,
  ExportRow,
} from "@/services/reports/ReportExportService";
import {
  CashierPerformanceReport,
  FraudDetectionReport,
  ABCAnalysisReport,
  CustomerAnalyticsReport,
  PaymentBreakdownReport,
  TaxSummaryReport,
} from "@/components/pos/EnhancedReports";
import { ShiftIntegrityCard } from "@/components/pos/ShiftIntegrityCard";
import { format, subDays } from "date-fns";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  TrendingUp,
  DollarSign,
  ShoppingCart,
  Calendar as CalendarIcon,
  Download,
  FileText,
  ArrowUpRight,
  ArrowDownRight,
  FileSpreadsheet,
  Printer,
  Search,
  Receipt,
  Eye,
} from "lucide-react";

const COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

export default function POSReports() {
  const [dateRange, setDateRange] = useState<{ from: Date; to: Date }>({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [selectedRegister, setSelectedRegister] = useState<string>("all");
  const [selectedBranch, setSelectedBranch] = useState<string>("all");
  const [activeTab, setActiveTab] = useState("daily");
  const [receiptSearch, setReceiptSearch] = useState("");
  const [selectedReceipt, setSelectedReceipt] =
    useState<POSTransactionRecord | null>(null);
  const [receiptDetails, setReceiptDetails] =
    useState<POSTransactionRecord | null>(null);
  const [isReceiptPreviewOpen, setIsReceiptPreviewOpen] = useState(false);

  const dateFrom = format(dateRange.from, "yyyy-MM-dd");
  const dateTo = format(dateRange.to, "yyyy-MM-dd");

  const { branches, hasMultipleBranches } = useBranch();
  const {
    dailySales,
    isDailySalesLoading,
    hourlySales,
    isHourlySalesLoading,
    topProducts,
    isTopProductsLoading,
  } = usePOSReports({
    dateFrom,
    dateTo,
    registerId: selectedRegister,
    branchId: selectedBranch,
  });
  const { registers } = usePOSRegisters();
  const { formatCurrency, getCurrencySymbol, baseCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const [isDispatchingReceipt, setIsDispatchingReceipt] = useState(false);

  // Filter registers by selected branch so the register picker stays coherent
  const visibleRegisters =
    selectedBranch === "all"
      ? registers
      : registers.filter((r) => r.branch_id === selectedBranch);

  // Enhanced reports data for export (only needed for export configs)
  const enhancedData = usePOSEnhancedReports({
    dateFrom,
    dateTo,
    registerId: selectedRegister,
    branchId: selectedBranch,
  });
  const scopeLabel =
    selectedRegister !== "all"
      ? `Register: ${registers.find((r) => r.id === selectedRegister)?.register_name ?? "Selected register"}`
      : selectedBranch !== "all"
        ? `Branch: ${branches.find((b) => b.id === selectedBranch)?.name ?? "Selected branch"}`
        : "Company-wide";

  const totalSales = dailySales.reduce((sum, d) => sum + d.total, 0);
  const totalTransactions = dailySales.reduce(
    (sum, d) => sum + d.transactions,
    0,
  );
  const averageTransaction =
    totalTransactions > 0 ? totalSales / totalTransactions : 0;

  const midPoint = Math.floor(dailySales.length / 2);
  const recentSales = dailySales
    .slice(midPoint)
    .reduce((sum, d) => sum + d.total, 0);
  const previousSales = dailySales
    .slice(0, midPoint)
    .reduce((sum, d) => sum + d.total, 0);
  const salesTrend =
    previousSales > 0
      ? ((recentSales - previousSales) / previousSales) * 100
      : 0;

  const hourlyChartData = hourlySales.map((h) => ({
    hour: `${h.hour.toString().padStart(2, "0")}:00`,
    sales: h.total,
    transactions: h.transactions,
  }));

  const productPieData = topProducts.slice(0, 5).map((p, i) => ({
    name: p.name,
    value: p.revenue,
    fill: COLORS[i % COLORS.length],
  }));

  const filterProps = { dateFrom, dateTo, registerId: selectedRegister };

  const {
    transactions: receiptTransactions,
    isLoading: isReceiptTransactionsLoading,
    getTransactionDetails,
  } = usePOSTransactionHistory({
    dateFrom,
    dateTo,
    registerId: selectedRegister !== "all" ? selectedRegister : undefined,
    branchId: selectedBranch !== "all" ? selectedBranch : undefined,
    searchQuery: receiptSearch.trim() || undefined,
  });

  const handleOpenReceipt = useCallback(
    async (transaction: POSTransactionRecord) => {
      setSelectedReceipt(transaction);
      const details = await getTransactionDetails(transaction.id);
      setReceiptDetails(details);
    },
    [getTransactionDetails],
  );

  const handleReceiptPdf = useCallback(
    (transaction: POSTransactionRecord) => {
      downloadPdf(
        "pos_receipt",
        transaction.id,
        `receipt-${transaction.transaction_number}`,
      );
    },
    [downloadPdf],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [];
    const rows: ExportRow[] = [];

    switch (activeTab) {
      case "daily":
      case "hourly": {
        columns.push(
          {
            key: "period",
            header: activeTab === "daily" ? "Date" : "Hour",
            width: 20,
          },
          {
            key: "sales",
            header: "Sales",
            width: 18,
            format: "currency",
            align: "right",
          },
          {
            key: "transactions",
            header: "Transactions",
            width: 14,
            format: "number",
            align: "right",
          },
        );
        const source = activeTab === "daily" ? dailySales : hourlySales;
        for (const item of source) {
          rows.push({
            period:
              activeTab === "daily"
                ? (item as any).date
                : `${String((item as any).hour).padStart(2, "0")}:00`,
            sales: (item as any).total,
            transactions: (item as any).transactions,
          });
        }
        rows.push({
          period: "TOTAL",
          sales: source.reduce((s, i) => s + (i as any).total, 0),
          transactions: source.reduce((s, i) => s + (i as any).transactions, 0),
          _isGrandTotal: true,
        });
        break;
      }
      case "products": {
        columns.push(
          { key: "product", header: "Product", width: 30 },
          {
            key: "qty",
            header: "Quantity",
            width: 14,
            format: "number",
            align: "right",
          },
          {
            key: "revenue",
            header: "Revenue",
            width: 18,
            format: "currency",
            align: "right",
          },
        );
        for (const p of topProducts)
          rows.push({ product: p.name, qty: p.quantity, revenue: p.revenue });
        break;
      }
      case "receipts": {
        columns.push(
          { key: "receipt", header: "Receipt #", width: 24 },
          { key: "date", header: "Date/Time", width: 24 },
          { key: "customer", header: "Customer", width: 24 },
          { key: "status", header: "Status", width: 14 },
          {
            key: "total",
            header: "Total",
            width: 18,
            format: "currency",
            align: "right",
          },
        );
        for (const tx of receiptTransactions) {
          rows.push({
            receipt: tx.transaction_number,
            date: format(new Date(tx.created_at), "MMM d, yyyy h:mm a"),
            customer: tx.customer_name || "Walk-in",
            status: tx.status,
            total: tx.total,
          });
        }
        break;
      }
      case "cashiers": {
        columns.push(
          { key: "cashier", header: "Cashier", width: 25 },
          {
            key: "sales",
            header: "Total Sales",
            width: 18,
            format: "currency",
            align: "right",
          },
          {
            key: "txns",
            header: "Transactions",
            width: 14,
            format: "number",
            align: "right",
          },
          {
            key: "avg",
            header: "Avg Sale",
            width: 16,
            format: "currency",
            align: "right",
          },
          {
            key: "returns",
            header: "Returns",
            width: 12,
            format: "number",
            align: "right",
          },
          {
            key: "voids",
            header: "Voids",
            width: 10,
            format: "number",
            align: "right",
          },
          {
            key: "cash_var",
            header: "Cash +/-",
            width: 14,
            format: "currency",
            align: "right",
          },
        );
        for (const c of enhancedData.cashierPerformance) {
          rows.push({
            cashier: c.user_email,
            sales: c.total_sales,
            txns: c.transaction_count,
            avg: c.avg_transaction,
            returns: c.returns_count,
            voids: c.void_count,
            cash_var: c.cash_over_short,
          });
        }
        break;
      }
      case "payments": {
        columns.push(
          { key: "method", header: "Payment Method", width: 25 },
          {
            key: "amount",
            header: "Total Amount",
            width: 18,
            format: "currency",
            align: "right",
          },
          {
            key: "txns",
            header: "Transactions",
            width: 14,
            format: "number",
            align: "right",
          },
          {
            key: "pct",
            header: "%",
            width: 10,
            format: "percent",
            align: "right",
          },
        );
        for (const p of enhancedData.paymentBreakdown) {
          rows.push({
            method: p.payment_method,
            amount: p.total_amount,
            txns: p.transaction_count,
            pct: p.percentage,
          });
        }
        break;
      }
      case "tax": {
        columns.push(
          { key: "rate", header: "Tax Rate", width: 14 },
          {
            key: "taxable",
            header: "Taxable Amount",
            width: 18,
            format: "currency",
            align: "right",
          },
          {
            key: "tax",
            header: "Tax Collected",
            width: 18,
            format: "currency",
            align: "right",
          },
          {
            key: "items",
            header: "Line Items",
            width: 14,
            format: "number",
            align: "right",
          },
        );
        for (const t of enhancedData.taxSummary) {
          rows.push({
            rate: `${t.tax_rate}%`,
            taxable: t.taxable_amount,
            tax: t.tax_amount,
            items: t.transaction_count,
          });
        }
        break;
      }
      case "abc": {
        columns.push(
          { key: "product", header: "Product", width: 30 },
          { key: "category", header: "Category", width: 10 },
          {
            key: "revenue",
            header: "Revenue",
            width: 18,
            format: "currency",
            align: "right",
          },
          {
            key: "qty",
            header: "Quantity",
            width: 14,
            format: "number",
            align: "right",
          },
          {
            key: "pct",
            header: "% Revenue",
            width: 12,
            format: "percent",
            align: "right",
          },
        );
        for (const p of enhancedData.abcAnalysis) {
          rows.push({
            product: p.name,
            category: p.category,
            revenue: p.revenue,
            qty: p.quantity,
            pct: p.revenue_percent,
          });
        }
        break;
      }
      case "fraud": {
        columns.push(
          { key: "severity", header: "Severity", width: 12 },
          { key: "type", header: "Type", width: 18 },
          { key: "user", header: "User", width: 25 },
          { key: "description", header: "Description", width: 40 },
          {
            key: "count",
            header: "Count",
            width: 10,
            format: "number",
            align: "right",
          },
          {
            key: "amount",
            header: "Amount",
            width: 16,
            format: "currency",
            align: "right",
          },
        );
        for (const f of enhancedData.fraudIndicators) {
          rows.push({
            severity: f.severity.toUpperCase(),
            type: f.type,
            user: f.user_email,
            description: f.description,
            count: f.count,
            amount: f.amount,
          });
        }
        break;
      }
      default: {
        columns.push(
          { key: "metric", header: "Metric", width: 30 },
          {
            key: "value",
            header: "Value",
            width: 20,
            format: "currency",
            align: "right",
          },
        );
        rows.push({ metric: "Total Sales", value: totalSales });
        rows.push({ metric: "Total Transactions", value: totalTransactions });
        rows.push({ metric: "Average Transaction", value: averageTransaction });
      }
    }

    return {
      title: `POS Report — ${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}`,
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(dateRange.from, "MMM d, yyyy")} – ${format(dateRange.to, "MMM d, yyyy")}`,
      columns,
      rows,
      sheetName: "POS Report",
      currency: baseCurrency,
    };
  }, [
    activeTab,
    dailySales,
    hourlySales,
    topProducts,
    receiptTransactions,
    totalSales,
    totalTransactions,
    averageTransaction,
    dateRange,
    currentOrg,
    baseCurrency,
    enhancedData,
  ]);

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold">
            POS Reports
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Sales analytics and insights • {scopeLabel}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {hasMultipleBranches && (
            <Select
              value={selectedBranch}
              onValueChange={(v) => {
                setSelectedBranch(v);
                // If active register no longer belongs to the selected branch, clear it
                if (v !== "all" && selectedRegister !== "all") {
                  const r = registers.find((x) => x.id === selectedRegister);
                  if (!r || r.branch_id !== v) setSelectedRegister("all");
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-[160px]">
                <SelectValue placeholder="All Branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={selectedRegister} onValueChange={setSelectedRegister}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue placeholder="All Registers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Registers</SelectItem>
              {visibleRegisters.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.register_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="w-full sm:w-auto justify-start text-xs sm:text-sm"
              >
                <CalendarIcon className="h-4 w-4 mr-2 shrink-0" />
                <span className="truncate">
                  {format(dateRange.from, "MMM d")} -{" "}
                  {format(dateRange.to, "MMM d")}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={{ from: dateRange.from, to: dateRange.to }}
                onSelect={(range) => {
                  if (range?.from && range?.to)
                    setDateRange({ from: range.from, to: range.to });
                }}
                numberOfMonths={1}
                className="md:hidden"
              />
              <Calendar
                mode="range"
                selected={{ from: dateRange.from, to: dateRange.to }}
                onSelect={(range) => {
                  if (range?.from && range?.to)
                    setDateRange({ from: range.from, to: range.to });
                }}
                numberOfMonths={2}
                className="hidden md:block"
              />
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full sm:w-auto">
                <Download className="h-4 w-4 mr-2" />
                <span className="sm:inline">Export</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportToCSV(getExportConfig())}>
                <FileText className="h-4 w-4 mr-2" /> CSV
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => exportToExcel(getExportConfig())}
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" /> Excel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportToPDF(getExportConfig())}>
                <Printer className="h-4 w-4 mr-2" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <SaveViewButton
            reportType="pos-reports"
            currentFilters={{
              dateFrom,
              dateTo,
              selectedRegister,
              selectedBranch,
              activeTab,
            }}
            onLoadView={(filters) => {
              if (filters.dateFrom && filters.dateTo)
                setDateRange({
                  from: new Date(filters.dateFrom),
                  to: new Date(filters.dateTo),
                });
              if (filters.selectedRegister)
                setSelectedRegister(filters.selectedRegister);
              if (filters.selectedBranch)
                setSelectedBranch(filters.selectedBranch);
              if (filters.activeTab) setActiveTab(filters.activeTab);
            }}
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium truncate">
              Total Sales
            </CardTitle>
            <DollarSign className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
            <div className="text-base xs:text-lg sm:text-2xl font-bold break-all">
              {formatCurrency(totalSales)}
            </div>
            <div className="flex items-center flex-wrap text-[10px] sm:text-xs text-muted-foreground mt-1">
              {salesTrend >= 0 ? (
                <>
                  <ArrowUpRight className="h-2 w-2 sm:h-3 sm:w-3 text-green-600 mr-1 shrink-0" />
                  <span className="text-green-600">
                    +{salesTrend.toFixed(1)}%
                  </span>
                </>
              ) : (
                <>
                  <ArrowDownRight className="h-2 w-2 sm:h-3 sm:w-3 text-red-600 mr-1 shrink-0" />
                  <span className="text-red-600">{salesTrend.toFixed(1)}%</span>
                </>
              )}
              <span className="ml-1 hidden sm:inline">vs previous</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium truncate">
              Transactions
            </CardTitle>
            <ShoppingCart className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
            <div className="text-base xs:text-lg sm:text-2xl font-bold break-all">
              {totalTransactions.toLocaleString()}
            </div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {dailySales.length > 0
                ? Math.round(
                    totalTransactions / dailySales.length,
                  ).toLocaleString()
                : 0}{" "}
              <span className="hidden xs:inline">avg</span> /day
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium truncate">
              Avg. Transaction
            </CardTitle>
            <TrendingUp className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
            <div className="text-base xs:text-lg sm:text-2xl font-bold break-all">
              {formatCurrency(averageTransaction)}
            </div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              Per sale
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium truncate">
              Top Product
            </CardTitle>
            <FileText className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
            <div
              className="text-sm xs:text-base sm:text-lg font-bold line-clamp-2"
              title={topProducts[0]?.name}
            >
              {topProducts[0]?.name || "—"}
            </div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {topProducts[0]
                ? `${topProducts[0].quantity.toLocaleString()} units sold`
                : "No data"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-3 sm:space-y-4"
      >
        <div className="overflow-x-auto -mx-2 px-2 sm:mx-0 sm:px-0">
          <TabsList className="inline-flex h-auto w-auto min-w-full sm:min-w-0 gap-1 p-1">
            <TabsTrigger
              value="daily"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Daily
            </TabsTrigger>
            <TabsTrigger
              value="hourly"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Hourly
            </TabsTrigger>
            <TabsTrigger
              value="receipts"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Receipts
            </TabsTrigger>
            <TabsTrigger
              value="products"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Products
            </TabsTrigger>
            <TabsTrigger
              value="payments"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Payments
            </TabsTrigger>
            <TabsTrigger
              value="tax"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Tax
            </TabsTrigger>
            <TabsTrigger
              value="cashiers"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Cashiers
            </TabsTrigger>
            <TabsTrigger
              value="analytics"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Customers
            </TabsTrigger>
            <TabsTrigger
              value="abc"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              ABC
            </TabsTrigger>
            <TabsTrigger
              value="fraud"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Fraud
            </TabsTrigger>
            <TabsTrigger
              value="integrity"
              className="text-xs sm:text-sm px-2 sm:px-3"
            >
              Integrity
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="daily">
          <Card>
            <CardHeader className="p-3 sm:p-6">
              <CardTitle className="text-sm sm:text-base">
                Daily Sales Trend
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Revenue over selected period
              </CardDescription>
            </CardHeader>
            <CardContent className="p-2 sm:p-6 pt-0">
              {isDailySalesLoading ? (
                <div className="h-[250px] sm:h-[400px] flex items-center justify-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                </div>
              ) : dailySales.length === 0 ? (
                <div className="h-[250px] sm:h-[400px] flex items-center justify-center text-muted-foreground text-sm">
                  No sales data available
                </div>
              ) : (
                <ResponsiveContainer
                  width="100%"
                  height={window.innerWidth < 640 ? 250 : 400}
                >
                  <BarChart data={dailySales}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-muted"
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(v) =>
                        format(
                          new Date(v),
                          window.innerWidth < 640 ? "d" : "MMM d",
                        )
                      }
                      tick={{ fontSize: window.innerWidth < 640 ? 10 : 12 }}
                    />
                    <YAxis
                      tickFormatter={(v) => `${getCurrencySymbol()}${v}`}
                      tick={{ fontSize: window.innerWidth < 640 ? 10 : 12 }}
                      width={window.innerWidth < 640 ? 50 : 60}
                    />
                    <Tooltip
                      formatter={(value: number) => [
                        formatCurrency(value),
                        "Sales",
                      ]}
                      labelFormatter={(label) =>
                        format(new Date(label), "MMMM d, yyyy")
                      }
                    />
                    <Bar
                      dataKey="total"
                      fill="hsl(var(--primary))"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hourly">
          <Card>
            <CardHeader className="p-3 sm:p-6">
              <CardTitle className="text-sm sm:text-base">
                Sales by Hour (Today)
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Peak hours and traffic patterns
              </CardDescription>
            </CardHeader>
            <CardContent className="p-2 sm:p-6 pt-0">
              {isHourlySalesLoading ? (
                <div className="h-[250px] sm:h-[400px] flex items-center justify-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                </div>
              ) : (
                <ResponsiveContainer
                  width="100%"
                  height={window.innerWidth < 640 ? 250 : 400}
                >
                  <LineChart data={hourlyChartData}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-muted"
                    />
                    <XAxis
                      dataKey="hour"
                      tick={{ fontSize: window.innerWidth < 640 ? 10 : 12 }}
                    />
                    <YAxis
                      tickFormatter={(v) => `${getCurrencySymbol()}${v}`}
                      tick={{ fontSize: window.innerWidth < 640 ? 10 : 12 }}
                      width={window.innerWidth < 640 ? 50 : 60}
                    />
                    <Tooltip
                      formatter={(value: number) => [
                        formatCurrency(value),
                        "Sales",
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="sales"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={{
                        fill: "hsl(var(--primary))",
                        r: window.innerWidth < 640 ? 2 : 4,
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="receipts">
          <Card>
            <CardHeader className="p-3 sm:p-6">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle className="text-sm sm:text-base">
                    Receipt Lookup
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    Trace individual POS sales by receipt number, customer,
                    date, register, or branch.
                  </CardDescription>
                </div>
                <div className="relative w-full lg:w-80">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={receiptSearch}
                    onChange={(event) => setReceiptSearch(event.target.value)}
                    placeholder="Receipt # or customer"
                    className="pl-10"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="rounded-md border">
                  {isReceiptTransactionsLoading ? (
                    <div className="flex h-72 items-center justify-center">
                      <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                    </div>
                  ) : receiptTransactions.length === 0 ? (
                    <div className="flex h-72 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      <Receipt className="h-10 w-10 opacity-40" />
                      <span>No receipts match the selected filters.</span>
                    </div>
                  ) : (
                    <ScrollArea className="h-[420px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Receipt</TableHead>
                            <TableHead>Customer</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Total</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {receiptTransactions.map((tx) => (
                            <TableRow
                              key={tx.id}
                              className={
                                selectedReceipt?.id === tx.id
                                  ? "bg-muted/50"
                                  : undefined
                              }
                            >
                              <TableCell>
                                <button
                                  className="text-left"
                                  onClick={() => handleOpenReceipt(tx)}
                                >
                                  <div className="font-medium">
                                    {tx.transaction_number}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {format(
                                      new Date(tx.created_at),
                                      "MMM d, yyyy h:mm a",
                                    )}
                                  </div>
                                </button>
                              </TableCell>
                              <TableCell>
                                {tx.customer_name || "Walk-in"}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="capitalize">
                                  {tx.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {formatCurrency(tx.total)}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleOpenReceipt(tx)}
                                >
                                  <Eye className="mr-1 h-4 w-4" /> View
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  )}
                </div>

                <div className="rounded-md border p-4">
                  {!receiptDetails ? (
                    <div className="flex h-full min-h-72 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      <Receipt className="h-10 w-10 opacity-40" />
                      <span>Select a receipt to inspect the exact sale.</span>
                    </div>
                  ) : (
                    <div className="space-y-4 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold">
                            {receiptDetails.transaction_number}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {format(
                              new Date(receiptDetails.created_at),
                              "MMM d, yyyy h:mm a",
                            )}
                          </p>
                        </div>
                        <Badge variant="outline" className="capitalize">
                          {receiptDetails.status}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <p className="text-muted-foreground">Customer</p>
                          <p className="font-medium">
                            {receiptDetails.customer_name || "Walk-in"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Register</p>
                          <p className="font-medium">
                            {receiptDetails.register?.register_name || "—"}
                          </p>
                        </div>
                      </div>

                      <div>
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          Items sold
                        </p>
                        <div className="space-y-2">
                          {(receiptDetails.items || []).map((item) => (
                            <div
                              key={item.id}
                              className="rounded-md bg-muted/40 p-2"
                            >
                              <div className="flex justify-between gap-3">
                                <span className="font-medium">
                                  {item.description}
                                </span>
                                <span className="shrink-0">
                                  {formatCurrency(item.line_total)}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {item.quantity} ×{" "}
                                {formatCurrency(item.unit_price)}
                                {item.tax_amount
                                  ? ` • Tax ${formatCurrency(item.tax_amount)}`
                                  : ""}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-1 border-t pt-3">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            Subtotal
                          </span>
                          <span>{formatCurrency(receiptDetails.subtotal)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Tax</span>
                          <span>
                            {formatCurrency(receiptDetails.tax_amount)}
                          </span>
                        </div>
                        {receiptDetails.discount_amount > 0 && (
                          <div className="flex justify-between text-green-600">
                            <span>Discount</span>
                            <span>
                              -{formatCurrency(receiptDetails.discount_amount)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between border-t pt-2 font-semibold">
                          <span>Total</span>
                          <span>{formatCurrency(receiptDetails.total)}</span>
                        </div>
                      </div>

                      <div>
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          Payments
                        </p>
                        <div className="space-y-1">
                          {(receiptDetails.payments || []).map((payment) => (
                            <div
                              key={payment.id}
                              className="flex justify-between text-xs"
                            >
                              <span className="capitalize">
                                {payment.payment_method.replace(/_/g, " ")}
                              </span>
                              <span>
                                {formatCurrency(Math.abs(payment.amount))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-2">
                        <Button
                          variant="outline"
                          onClick={() => setIsReceiptPreviewOpen(true)}
                        >
                          <Printer className="mr-2 h-4 w-4" /> Reprint
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleReceiptPdf(receiptDetails)}
                          disabled={isGeneratingPdf}
                        >
                          <Download className="mr-2 h-4 w-4" /> PDF
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="products">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-6">
            <Card>
              <CardHeader className="p-3 sm:p-6">
                <CardTitle className="text-sm sm:text-base">
                  Top Products by Revenue
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 sm:p-6 pt-0">
                {isTopProductsLoading ? (
                  <div className="h-[200px] flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                  </div>
                ) : topProducts.length === 0 ? (
                  <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                    No product data
                  </div>
                ) : (
                  <div className="space-y-2 sm:space-y-4">
                    {topProducts.slice(0, 10).map((product, index) => (
                      <div
                        key={product.name}
                        className="flex items-center gap-2 sm:gap-4"
                      >
                        <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs sm:text-sm font-medium shrink-0">
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate text-xs sm:text-sm">
                            {product.name}
                          </p>
                          <p className="text-[10px] sm:text-sm text-muted-foreground">
                            {product.quantity} units
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-semibold text-xs sm:text-sm">
                            {formatCurrency(product.revenue)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3 sm:p-6">
                <CardTitle className="text-sm sm:text-base">
                  Revenue Distribution
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 sm:p-6 pt-0">
                {isTopProductsLoading || productPieData.length === 0 ? (
                  <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                    {isTopProductsLoading ? (
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                    ) : (
                      "No data"
                    )}
                  </div>
                ) : (
                  <>
                    <ResponsiveContainer
                      width="100%"
                      height={window.innerWidth < 640 ? 200 : 300}
                    >
                      <PieChart>
                        <Pie
                          data={productPieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={window.innerWidth < 640 ? 40 : 60}
                          outerRadius={window.innerWidth < 640 ? 70 : 100}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {productPieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.fill} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: number) => formatCurrency(value)}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-2 sm:mt-4 space-y-1 sm:space-y-2">
                      {productPieData.map((product, index) => (
                        <div
                          key={product.name}
                          className="flex items-center gap-2 text-xs sm:text-sm"
                        >
                          <div
                            className="w-2 h-2 sm:w-3 sm:h-3 rounded-full shrink-0"
                            style={{
                              backgroundColor: COLORS[index % COLORS.length],
                            }}
                          />
                          <span className="flex-1 truncate">
                            {product.name}
                          </span>
                          <span className="font-medium shrink-0">
                            {formatCurrency(product.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="payments">
          <PaymentBreakdownReport {...filterProps} />
        </TabsContent>

        <TabsContent value="tax">
          <TaxSummaryReport {...filterProps} />
        </TabsContent>

        <TabsContent value="cashiers">
          <CashierPerformanceReport {...filterProps} />
        </TabsContent>

        <TabsContent value="analytics">
          <CustomerAnalyticsReport {...filterProps} />
        </TabsContent>

        <TabsContent value="abc">
          <ABCAnalysisReport {...filterProps} />
        </TabsContent>

        <TabsContent value="fraud">
          <FraudDetectionReport {...filterProps} />
        </TabsContent>

        <TabsContent value="integrity">
          {/* MC-2: shift total drift detector. Branch filter follows page-level scope. */}
          <ShiftIntegrityCard
            dateFrom={dateFrom}
            dateTo={dateTo}
            branchId={selectedBranch}
          />
        </TabsContent>
      </Tabs>

      {/* Admin reprint from a report row — legitimate page-level dialog
          (not a workstation sheet), so inlined here rather than routed
          through the retired `ReceiptPreviewDialog` shell. */}
      <Dialog open={isReceiptPreviewOpen} onOpenChange={setIsReceiptPreviewOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-2xl lg:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Transaction Complete</DialogTitle>
          </DialogHeader>
          {receiptDetails && (
            <ReceiptPreviewBody
              transaction={{
                id: receiptDetails.id,
                transaction_number: receiptDetails.transaction_number,
                total_amount: receiptDetails.total,
                subtotal: receiptDetails.subtotal,
                tax_amount: receiptDetails.tax_amount,
                discount_amount: receiptDetails.discount_amount,
                created_at: receiptDetails.created_at,
                payment_method: receiptDetails.payments?.[0]?.payment_method,
                customer_name: receiptDetails.customer_name ?? undefined,
                register_id: receiptDetails.register_id,
                invoice_id: receiptDetails.invoice_id,
                items: (receiptDetails.items || []).map((item) => ({
                  product_name: item.description,
                  quantity: item.quantity,
                  unit_price: item.unit_price,
                  discount_amount: item.discount_value ?? 0,
                  line_total: item.line_total,
                })),
                payments: (receiptDetails.payments || []).map((payment) => ({
                  payment_method: payment.payment_method,
                  amount: payment.amount,
                  reference: payment.reference ?? undefined,
                })),
                is_voided: receiptDetails.status === "voided",
                is_refund: receiptDetails.transaction_type === "return",
              }}
              onClose={() => setIsReceiptPreviewOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
