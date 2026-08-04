import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { PAYMENT_IMPORT_FIELDS } from "@/lib/importConfigs/paymentImportConfig";
import { deriveInvoiceFromAllocations } from "@/lib/payments/deriveInvoiceFromAllocations";
import { ToastAction } from "@/components/ui/toast";
import { useSearchParams } from "react-router-dom";
import { usePayments, Payment } from "@/hooks/usePayments";
import { useCurrency } from "@/hooks/useCurrency";
import { useExport } from "@/hooks/useExport";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { useContacts } from "@/hooks/useContacts";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { fetchAndBuildPaymentReceiptSnapshot } from "@/services/documents/snapshots/salesPaymentReceipt";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { printDocumentIntent } from "@/services/printing/PrintService";
import { normalizeError } from "@/services/resilience";
import { BulkActionsToolbar } from "@/components/common/BulkActionsToolbar";
import { RecordPaymentDialog } from "@/components/sales/RecordPaymentDialog";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { VoidPaymentDialog } from "@/components/payments/VoidPaymentDialog";
import { ReversePaymentWizard } from "@/components/payments/ReversePaymentWizard";
import { ReapplyPaymentDialog } from "@/components/payments/ReapplyPaymentDialog";
import { ApplyCustomerDepositDialog } from "@/components/payments/ApplyCustomerDepositDialog";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ContactResolver } from "@/lib/entityResolver";
import { ImportResults } from "@/hooks/useImport";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { useViewMode } from "@/hooks/useViewMode";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { 
  Plus, 
  Search, 
  MoreHorizontal, 
  FileText, 
  Loader2, 
  CreditCard, 
  Download, 
  Ban,
  Unlink,
  ArrowRightLeft,
  Upload,
  TrendingUp,
  Users,
  Mail,
  Printer,
} from "lucide-react";
import { format, isWithinInterval, parseISO, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import { CustomerPaymentPeekSheet } from "@/features/sales/payments/CustomerPaymentPeekSheet";
import { usePeekParam } from "@/features/sales/record";
import { PaymentListTable } from "@/components/payments/PaymentListTable";
import { Eye } from "lucide-react";
import { printOutcomeToast } from "@/services/printing/printOutcomeToast";

// Extended payment type with status
interface PaymentWithStatus extends Payment {
  status?: "applied" | "voided" | "unreconciled";
}

const DATE_RANGE_OPTIONS = [
  { value: "all", label: "All Time" },
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "last_3_months", label: "Last 3 Months" },
  { value: "custom", label: "Custom Range" },
];

const METHOD_OPTIONS = [
  { value: "all", label: "All Methods" },
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "credit_card", label: "Credit Card" },
  { value: "check", label: "Check" },
  { value: "mpesa", label: "M-Pesa" },
  { value: "mobile_money", label: "Mobile Money" },
  { value: "other", label: "Other" },
];

export default function CustomerPayments() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { payments, isLoading, refreshPayments, recordPayment } = usePayments();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { exportPayments } = useExport();
  const { toast } = useToast();
  const { contacts } = useContacts();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { accounts: defaultAcctMappings } = useDefaultAccounts();

  // Studio integration
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "payment" });
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters } = useCustomFieldFiltering("payment");
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [methodFilter, setMethodFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState("all");
  const [customDateFrom, setCustomDateFrom] = useState("");
  const [customDateTo, setCustomDateTo] = useState("");
  const [showRecordDialog, setShowRecordDialog] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);

  // Handle ?action=create from global create menu
  useEffect(() => {
    if (searchParams.get("action") === "create" && !showRecordDialog) {
      setShowRecordDialog(true);
    }
  }, [searchParams]);

  const [selectedPayment, setSelectedPayment] = useState<PaymentWithStatus | null>(null);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [showUnreconcileDialog, setShowUnreconcileDialog] = useState(false);
  const [showReapplyDialog, setShowReapplyDialog] = useState(false);
  const [showApplyDepositDialog, setShowApplyDepositDialog] = useState(false);
  const [peekId, setPeekId] = usePeekParam();
  const contactResolverRef = useRef<ContactResolver | null>(null);

  // Handle ?id= deep-link to auto-open a specific payment
  const paymentsWithStatus = payments as PaymentWithStatus[];

  useEffect(() => {
    const targetId = searchParams.get("id");
    if (!targetId) return;
    setPeekId(targetId);
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, setPeekId]);


  const paymentFieldDefinitions = PAYMENT_IMPORT_FIELDS;

  const handleImportPayment = useCallback(async (row: Record<string, any>) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("No company selected. Pick a company before importing.");

    if (!contactResolverRef.current) {
      contactResolverRef.current = new ContactResolver(currentOrg.id, currentBusiness.id, "customer", contacts);
    }

    let invoiceId: string | null = null;
    if (row.invoice_number) {
      const { data: invoice } = await supabase
        .from("invoices")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .ilike("invoice_number", row.invoice_number.trim())
        .limit(1);

      if (invoice && invoice.length > 0) {
        invoiceId = invoice[0].id;
      }
    }

    if (!invoiceId) {
      throw new Error(`Invoice "${row.invoice_number || "N/A"}" not found. Payments must be linked to an existing invoice.`);
    }

    // Resolve deposit account from payment method for imports
    const method = row.payment_method || "other";
    let depositAcct = "";
    switch (method) {
      case "cash": depositAcct = defaultAcctMappings.cash_account_id || defaultAcctMappings.bank_account_id || ""; break;
      case "bank_transfer": case "check": depositAcct = defaultAcctMappings.bank_account_id || defaultAcctMappings.cash_account_id || ""; break;
      case "credit_card": depositAcct = defaultAcctMappings.credit_card_clearing_id || defaultAcctMappings.bank_account_id || defaultAcctMappings.cash_account_id || ""; break;
      case "mpesa": depositAcct = defaultAcctMappings.mpesa_account_id || defaultAcctMappings.mobile_money_account_id || defaultAcctMappings.bank_account_id || defaultAcctMappings.cash_account_id || ""; break;
      case "mobile_money": depositAcct = defaultAcctMappings.mobile_money_account_id || defaultAcctMappings.bank_account_id || defaultAcctMappings.cash_account_id || ""; break;
      default: depositAcct = defaultAcctMappings.bank_account_id || defaultAcctMappings.cash_account_id || ""; break;
    }

    if (!depositAcct) {
      throw new Error("No deposit account mapped. Configure default accounts in Settings before importing payments.");
    }

    await recordPayment({
      invoice_id: invoiceId,
      amount: Number(row.amount) || 0,
      payment_date: row.payment_date || new Date().toISOString().split("T")[0],
      payment_method: method,
      reference: row.reference || undefined,
      notes: row.notes || undefined,
      deposit_account_id: depositAcct,
    });
  }, [currentOrg, contacts, recordPayment, defaultAcctMappings]);

  const handleImportComplete = () => {
    contactResolverRef.current = null;
    refreshPayments();
  };

  // paymentsWithStatus already declared above

  const filteredPayments = useMemo(() => {
    return paymentsWithStatus.filter(payment => {
      // Search — now also searches customer name
      const contact = payment.contact as { name: string } | null;
      const matchesSearch = !searchQuery ||
        payment.receipt_number?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        payment.reference?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        contact?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (payment as any).invoice?.invoice_number?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const status = payment.status || "applied";
      const matchesStatus = statusFilter === "all" || status === statusFilter;

      const matchesMethod = methodFilter === "all" || payment.payment_method === methodFilter;
      
      // Date range filter
      let matchesDate = true;
      if (dateRange !== "all") {
        const payDate = parseISO(payment.payment_date);
        const now = new Date();
        if (dateRange === "this_month") {
          matchesDate = isWithinInterval(payDate, { start: startOfMonth(now), end: endOfMonth(now) });
        } else if (dateRange === "last_month") {
          const lm = subMonths(now, 1);
          matchesDate = isWithinInterval(payDate, { start: startOfMonth(lm), end: endOfMonth(lm) });
        } else if (dateRange === "last_3_months") {
          matchesDate = isWithinInterval(payDate, { start: startOfMonth(subMonths(now, 3)), end: endOfMonth(now) });
        } else if (dateRange === "custom" && customDateFrom && customDateTo) {
          matchesDate = isWithinInterval(payDate, { start: parseISO(customDateFrom), end: parseISO(customDateTo) });
        }
      }
      
      return matchesSearch && matchesStatus && matchesMethod && matchesDate;
    });
  }, [paymentsWithStatus, searchQuery, statusFilter, methodFilter, dateRange, customDateFrom, customDateTo]);

  // Running totals for filtered results
  const filteredTotal = useMemo(() => {
    return filteredPayments
      .filter(p => p.status !== "voided")
      .reduce((sum, p) => sum + p.amount, 0);
  }, [filteredPayments]);

  const bulkSelection = useBulkSelection({
    items: filteredPayments,
    getItemId: (payment) => payment.id,
  });

  const handleBulkExport = () => {
    const selectedItems = bulkSelection.selectedItems;
    exportPayments(selectedItems);
    toast({
      title: `Exported ${selectedItems.length} payment${selectedItems.length > 1 ? "s" : ""}`,
    });
    bulkSelection.clearSelection();
  };

  const handleActionSuccess = () => {
    refreshPayments();
  };

  const getMethodBadge = (method: string) => {
    const styles: Record<string, string> = {
      cash: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      bank_transfer: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      credit_card: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      mpesa: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      mobile_money: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
      cheque: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      check: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      other: "bg-muted text-muted-foreground",
    };
    return <Badge className={styles[method] || "bg-muted"}>{method.replace("_", " ")}</Badge>;
  };

  const getStatusBadge = (payment: PaymentWithStatus) => {
    const status = payment.status || "applied";
    if (status === "voided") {
      return <Badge variant="destructive">Voided</Badge>;
    }
    if (status === "unreconciled") {
      return <Badge variant="secondary">Unreconciled</Badge>;
    }
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Applied</Badge>;
  };

  // Filter out voided payments for stats
  const activePayments = paymentsWithStatus.filter(p => p.status !== "voided");
  const unreconciledPayments = paymentsWithStatus.filter(p => p.status === "unreconciled");

  const stats = {
    total: activePayments.length,
    totalAmount: activePayments.reduce((sum, p) => sum + p.amount, 0),
    thisMonth: activePayments.filter(p => {
      const date = new Date(p.payment_date);
      const now = new Date();
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    }).reduce((sum, p) => sum + p.amount, 0),
    unreconciled: unreconciledPayments.length,
    unreconciledAmount: unreconciledPayments.reduce((sum, p) => sum + p.amount, 0),
  };

  /**
   * Dispatch a customer payment receipt through the Wave 7 document engine.
   * All three legacy legs (view / download / print) collapse into one
   * intent submission — the resolved routing plan handles disposition
   * (screen preview, PDF download, thermal spooler, email, fiscal, …)
   * so a "receipt" print button never bypasses fiscal / archive rules.
   */
  const handleDispatchReceipt = useCallback(async (payment: Payment) => {
    if (!currentOrg?.id) {
      toast({
        title: "No organization",
        description: "Sign in to an organization before printing receipts.",
        variant: "destructive",
      });
      return;
    }
    const receiptNum = payment.receipt_number || `RCP-${payment.id.slice(0, 8)}`;
    try {
      const built = await fetchAndBuildPaymentReceiptSnapshot(supabase, payment.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.payment_receipt",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "payment_receipt",
        sourceDocId: payment.id,
        businessId: built.businessId ?? currentBusiness?.id ?? null,
        branchId: built.branchId ?? null,
        partyKind: "customer",
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
      });
      const result = await printDocumentIntent({
        documentRecordId,
        triggeredSource: "manual",
      });
      toast(printOutcomeToast(result, `Receipt ${receiptNum}`));
    } catch (err) {
      toast({
        title: "Receipt dispatch failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  }, [currentOrg?.id, currentBusiness?.id, toast]);

  const hasActiveFilters = statusFilter !== "all" || methodFilter !== "all" || dateRange !== "all" || searchQuery.length > 0;

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">Customer Payments</h1>
            <p className="text-muted-foreground text-sm sm:text-base">Track all payments received from customers</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="payment" />
            <StudioQuickPanelTrigger entityType="payment" />
            <RefreshButton
              queryKeyPrefixes={[
                ['payments'] as const,
                ['invoices'] as const,
              ]}
              tooltip="Refresh payments"
            />
            <ViewSwitcher
              entityType="payment"
              currentView={currentView}
              onViewChange={setView}
            />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "receipt", header: "Receipt #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 22 },
                  { key: "method", header: "Method", width: 14 },
                  { key: "invoice", header: "Invoice", width: 15 },
                  { key: "amount", header: "Amount", format: "currency", width: 14, align: "right" },
                ];
                const rows = filteredPayments.map((p) => ({
                  receipt: p.receipt_number || "",
                  date: p.payment_date,
                  customer: p.contact?.name || "",
                  method: p.payment_method || "",
                  invoice: p.invoice?.invoice_number || "",
                  amount: p.amount,
                }));
                return {
                  title: "Customer Payments Register",
                  companyName: currentOrg?.name,
                  columns: cols,
                  rows,
                  currency: baseCurrency,
                  organizationId: currentOrg?.id,
                } as ExportConfig;
              }}
            />
            <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
              <Upload className="mr-2 h-4 w-4" /> Import
            </Button>
            <Button onClick={() => setShowRecordDialog(true)} className="w-full sm:w-auto shrink-0">
              <Plus className="mr-2 h-4 w-4" />
              Record Payment
            </Button>
          </div>
        </div>

        <RecordPaymentDialog 
          open={showRecordDialog} 
          onOpenChange={setShowRecordDialog}
          onPaymentRecorded={(details) => {
            refreshPayments();
            // Offer to email receipt after successful payment
            if (details?.paymentId && details?.contactEmail) {
              const receiptNum = details.receiptNumber || `RCP-${details.paymentId.slice(0, 8)}`;
              toast({
                title: "Payment recorded successfully",
                description: `Email the receipt to ${details.contactName || details.contactEmail}?`,
                action: (
                  <ToastAction
                    altText="Email receipt"
                    onClick={() => {
                      setEmailDocument({
                        documentType: "receipt",
                        documentId: details.paymentId,
                        documentNumber: receiptNum,
                        recipientEmail: details.contactEmail,
                        recipientName: details.contactName,
                        total: details.amount,
                        currency: baseCurrency,
                      });
                      setShowEmailDialog(true);
                    }}
                  >
                    Email Receipt
                  </ToastAction>
                ),
                duration: 10000,
              });
            }
          }}
        />

        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Payment"
          fieldDefinitions={paymentFieldDefinitions}
          onImport={handleImportPayment}
          onComplete={handleImportComplete}
        />

        {/* Receipt preview/print/download all flow through the unified
            document engine via handleDispatchReceipt — no local dialog. */}

        {/* Stats */}
        <div className="stats-grid grid-cols-1 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <CreditCard className="h-3.5 w-3.5" />
                Total Payments
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" />
                Total Received
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {formatCurrency(stats.totalAmount, baseCurrency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>This Month</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">
                {formatCurrency(stats.thisMonth, baseCurrency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Unreconciled</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600">
                {stats.unreconciled} ({formatCurrency(stats.unreconciledAmount, baseCurrency)})
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by receipt #, customer, invoice, or reference..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full"
            />
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[140px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="applied">Applied</SelectItem>
                <SelectItem value="unreconciled">Unreconciled</SelectItem>
                <SelectItem value="voided">Voided</SelectItem>
              </SelectContent>
            </Select>
            <Select value={methodFilter} onValueChange={setMethodFilter}>
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue placeholder="All Methods" />
              </SelectTrigger>
              <SelectContent>
                {METHOD_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue placeholder="All Time" />
              </SelectTrigger>
              <SelectContent>
                {DATE_RANGE_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={() => { setStatusFilter("all"); setMethodFilter("all"); setDateRange("all"); setSearchQuery(""); }}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Custom date inputs */}
        {dateRange === "custom" && (
          <div className="flex items-center gap-2">
            <Input type="date" value={customDateFrom} onChange={e => setCustomDateFrom(e.target.value)} className="w-40" />
            <span className="text-muted-foreground text-sm">to</span>
            <Input type="date" value={customDateTo} onChange={e => setCustomDateTo(e.target.value)} className="w-40" />
          </div>
        )}

        {/* Results count + running total */}
        {hasActiveFilters && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {filteredPayments.length} of {paymentsWithStatus.length} payments
            </p>
            <p className="text-sm font-medium">
              Filtered total: <span className="text-green-600">{formatCurrency(filteredTotal, baseCurrency)}</span>
            </p>
          </div>
        )}

        <CustomFieldFilters entityType="payment" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={filteredPayments as unknown as Record<string, unknown>[]}
          entityType="payment"
        />

        {/* Table */}
        {currentView === "list" && <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredPayments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <CreditCard className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">{hasActiveFilters ? "No matching payments" : "No payments found"}</h3>
                <p className="text-muted-foreground mb-4">
                  {hasActiveFilters 
                    ? "Try adjusting your filters"
                    : "Record payments when customers pay their invoices"}
                </p>
                {!hasActiveFilters && (
                  <Button onClick={() => setShowRecordDialog(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Record Payment
                  </Button>
                )}
              </div>
            ) : (
              <PaymentListTable
                payments={filteredPayments}
                isLoading={isLoading}
                bulkSelection={bulkSelection}
                onViewDetail={(payment) => { setSelectedPayment(payment); setPeekId(payment.id); }}
                onViewReceipt={handleDispatchReceipt}
                onDownloadReceipt={handleDispatchReceipt}
                onPrintReceipt={handleDispatchReceipt}
                onEmailReceipt={(payment) => {
                  const receiptNum = payment.receipt_number || `RCP-${payment.id.slice(0, 8)}`;
                  const contact = payment.contact as { name: string; email?: string } | null;
                  setEmailDocument({
                    documentType: "receipt",
                    documentId: payment.id,
                    documentNumber: receiptNum,
                    recipientEmail: (payment.contact as any)?.email || "",
                    recipientName: contact?.name || "",
                    total: payment.amount,
                    currency: baseCurrency,
                  });
                  setShowEmailDialog(true);
                }}
                onVoid={(payment) => { setSelectedPayment(payment); setShowVoidDialog(true); }}
                onUnreconcile={(payment) => { setSelectedPayment(payment); setShowUnreconcileDialog(true); }}
                onReapply={(payment) => { setSelectedPayment(payment); setShowReapplyDialog(true); }}
                onApplyDeposit={(payment) => { setSelectedPayment(payment); setShowApplyDepositDialog(true); }}
              />
            )}
          </CardContent>
        </Card>}

        {/* Bulk Actions Toolbar */}
        <BulkActionsToolbar
          selectedCount={bulkSelection.selectedCount}
          onExport={handleBulkExport}
          onClearSelection={bulkSelection.clearSelection}
          entityName={bulkSelection.selectedCount === 1 ? "payment" : "payments"}
        />

        {/* Void Payment Dialog */}
        <VoidPaymentDialog
          payment={selectedPayment}
          open={showVoidDialog}
          onOpenChange={setShowVoidDialog}
          onSuccess={handleActionSuccess}
        />

        {/* Un-reconcile → ADR 0012 wrong_invoice_applied (unapply, parks cash on Customer Deposits) */}
        <ReversePaymentWizard
          payment={selectedPayment ? {
            id: selectedPayment.id,
            receipt_number: selectedPayment.receipt_number,
            amount: selectedPayment.amount,
            outstanding_amount: (selectedPayment as any).outstanding_amount ?? null,
            applied_amount: (selectedPayment as any).applied_amount ?? null,
            payment_date: selectedPayment.payment_date,
            invoice: (selectedPayment as any).invoice ?? null,
          } : null}
          open={showUnreconcileDialog}
          onOpenChange={setShowUnreconcileDialog}
          onSuccess={handleActionSuccess}
          initialReasonCode="wrong_invoice_applied"
        />

        {/* Re-apply Payment Dialog */}
        <ReapplyPaymentDialog
          payment={selectedPayment}
          open={showReapplyDialog}
          onOpenChange={setShowReapplyDialog}
          onSuccess={handleActionSuccess}
        />

        {/* Apply Customer Deposit (ADR 0012 R3) */}
        <ApplyCustomerDepositDialog
          contactId={selectedPayment?.contact_id ?? null}
          initialPaymentId={selectedPayment?.id}
          open={showApplyDepositDialog}
          onOpenChange={setShowApplyDepositDialog}
          onSuccess={handleActionSuccess}
        />

        {/* Payment Peek Sheet */}
        <CustomerPaymentPeekSheet
          paymentId={peekId}
          onOpenChange={(o) => { if (!o) setPeekId(null); }}
        />


        {/* Email Receipt Dialog */}
        <SendDocumentDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          document={emailDocument}
        />
      </div>
    </>
  );
}

