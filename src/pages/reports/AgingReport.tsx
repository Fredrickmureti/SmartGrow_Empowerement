/**
 * Aging Report Page
 * 
 * Track overdue receivables and payables with export functionality.
 */

import { useState, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DrillDownDialog, DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, AlertTriangle, Mail } from "lucide-react";
import { useAgingReport } from "@/hooks/useAgingReport";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { PeriodLockBanner } from "@/components/reports/PeriodLockBanner";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { ExportConfig, ExportColumn, ExportRow } from "@/services/reports/ReportExportService";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
function AgingReportInner() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialType = ((): "ar" | "ap" => {
    const raw = (searchParams.get("type") || "").toLowerCase();
    if (raw === "payable" || raw === "ap") return "ap";
    return "ar";
  })();
  const [reportType, setReportType] = useState<"ar" | "ap">(initialType);
  const [asOfDate, setAsOfDate] = useState(() => {
    const v = searchParams.get("as_of") || searchParams.get("asOf") || searchParams.get("date_to") || searchParams.get("dateTo");
    return v || format(new Date(), "yyyy-MM-dd");
  });
  const [expandedContacts, setExpandedContacts] = useState<Set<string>>(new Set());
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({ open: false, config: null });

  // React to URL changes from palette navigation.
  useEffect(() => {
    const raw = (searchParams.get("type") || "").toLowerCase();
    if (raw === "payable" || raw === "ap") setReportType("ap");
    else if (raw === "receivable" || raw === "ar") setReportType("ar");
  }, [searchParams]);

  const { filters } = useReportFilters();
  const { data, isLoading, error } = useAgingReport({ reportType, asOfDate, branchId: filters.branchId });
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { currentOrg } = useOrganization();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const controlAccountId = reportType === "ar" ? defaultAccounts.accounts_receivable_id : defaultAccounts.accounts_payable_id;

  const toggleContact = (contactId: string) => {
    const newExpanded = new Set(expandedContacts);
    if (newExpanded.has(contactId)) newExpanded.delete(contactId);
    else newExpanded.add(contactId);
    setExpandedContacts(newExpanded);
  };

  const getBucketColor = (bucket: string) => {
    switch (bucket) {
      case "current": return "bg-green-500";
      case "days30": return "bg-yellow-500";
      case "days60": return "bg-orange-500";
      case "days90": return "bg-red-500";
      default: return "bg-gray-500";
    }
  };

  const totalAmount = data?.summary.total || 0;

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "contact", header: reportType === "ar" ? "Customer" : "Supplier", width: 25 },
      { key: "current", header: "Current", width: 16, format: "currency", align: "right" },
      { key: "days30", header: "31-60 Days", width: 16, format: "currency", align: "right" },
      { key: "days60", header: "61-90 Days", width: 16, format: "currency", align: "right" },
      { key: "days90", header: "90+ Days", width: 16, format: "currency", align: "right" },
      { key: "total", header: "Total", width: 16, format: "currency", align: "right" },
    ];

    const rows: ExportRow[] = [];
    for (const contact of data?.contacts || []) {
      rows.push({
        contact: contact.contact_name,
        current: contact.buckets.current || null,
        days30: contact.buckets.days30 || null,
        days60: contact.buckets.days60 || null,
        days90: contact.buckets.days90 || null,
        total: contact.buckets.total,
      });
    }

    rows.push({
      contact: "TOTAL",
      current: data?.summary.current || 0,
      days30: data?.summary.days30 || 0,
      days60: data?.summary.days60 || 0,
      days90: data?.summary.days90 || 0,
      total: data?.summary.total || 0,
      _isGrandTotal: true,
    });

    return {
      title: reportType === "ar" ? "Accounts Receivable Aging" : "Accounts Payable Aging",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `As of ${format(new Date(asOfDate), "MMMM d, yyyy")}`,
      columns,
      rows,
      sheetName: reportType === "ar" ? "AR Aging" : "AP Aging",
      currency: baseCurrency,
    };
  }, [data, reportType, asOfDate, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Aging Report"
      description="Track overdue receivables and payables"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.contacts.length === 0}
      emptyMessage={`No outstanding ${reportType === "ar" ? "receivables" : "payables"}`}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['aging-report'] as const]} tooltip="Refresh aging report" />
          <SaveViewButton
            reportType="aging"
            currentFilters={{ reportType, asOfDate }}
            onLoadView={(filters) => {
              if (filters.reportType) setReportType(filters.reportType);
              if (filters.asOfDate) setAsOfDate(filters.asOfDate);
            }}
          />
        </>
      }
      filters={
        <ReportFilters
          dateMode="asof"
          dateFrom={asOfDate}
          dateTo={asOfDate}
          onDateFromChange={setAsOfDate}
          onDateToChange={setAsOfDate}
        >
          <ReportBranchFilter reportKind={reportType === "ar" ? "ar_aging" : "ap_aging"} />
          <Tabs value={reportType} onValueChange={(v) => setReportType(v as "ar" | "ap")}>
            <TabsList>
              <TabsTrigger value="ar">Accounts Receivable</TabsTrigger>
              <TabsTrigger value="ap">Accounts Payable</TabsTrigger>
            </TabsList>
          </Tabs>
        </ReportFilters>
      }
    >
      <PeriodLockBanner dateTo={asOfDate} />

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Current</CardTitle>
            <CardDescription>0-30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">
              {formatCurrency(data?.summary.current || 0, baseCurrency)}
            </p>
            {totalAmount > 0 && <Progress value={((data?.summary.current || 0) / totalAmount) * 100} className="h-2 mt-2" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">31-60 Days</CardTitle>
            <CardDescription>Overdue</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-yellow-600">
              {formatCurrency(data?.summary.days30 || 0, baseCurrency)}
            </p>
            {totalAmount > 0 && <Progress value={((data?.summary.days30 || 0) / totalAmount) * 100} className="h-2 mt-2" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">61-90 Days</CardTitle>
            <CardDescription>Overdue</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-orange-600">
              {formatCurrency(data?.summary.days60 || 0, baseCurrency)}
            </p>
            {totalAmount > 0 && <Progress value={((data?.summary.days60 || 0) / totalAmount) * 100} className="h-2 mt-2" />}
          </CardContent>
        </Card>
        <Card className={data?.summary.days90 && data.summary.days90 > 0 ? "border-destructive" : ""}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium">90+ Days</CardTitle>
              {(data?.summary.days90 || 0) > 0 && <AlertTriangle className="h-4 w-4 text-destructive" />}
            </div>
            <CardDescription>Seriously Overdue</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">
              {formatCurrency(data?.summary.days90 || 0, baseCurrency)}
            </p>
            {totalAmount > 0 && <Progress value={((data?.summary.days90 || 0) / totalAmount) * 100} className="h-2 mt-2" />}
          </CardContent>
        </Card>
        <Card className="bg-muted/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Outstanding</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(data?.summary.total || 0, baseCurrency)}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {data?.contacts.length || 0} {reportType === "ar" ? "customers" : "suppliers"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Aging by Contact */}
      <Card>
        <CardHeader>
          <CardTitle>{reportType === "ar" ? "Customer" : "Supplier"} Aging Detail</CardTitle>
          <CardDescription>Click to expand and see individual {reportType === "ar" ? "invoices" : "bills"}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {data?.contacts.map((contact) => {
              const isExpanded = expandedContacts.has(contact.contact_id);
              return (
                <Collapsible key={contact.contact_id} open={isExpanded} onOpenChange={() => toggleContact(contact.contact_id)}>
                  <CollapsibleTrigger asChild>
                    <div className="flex items-center justify-between p-4 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors">
                      <div className="flex items-center gap-3">
                        {isExpanded ? <ChevronDown className="h-5 w-5 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 text-muted-foreground" />}
                        <div>
                          <p
                            className="font-medium text-primary hover:underline cursor-pointer"
                            onClick={(e) => { e.stopPropagation(); navigate(`/contacts-app/profile?id=${contact.contact_id}`); }}
                          >
                            {contact.contact_name}
                          </p>
                          {contact.company && <p className="text-sm text-muted-foreground">{contact.company}</p>}
                        </div>
                        {contact.buckets.days90 > 0 && <Badge variant="destructive" className="ml-2">90+ days overdue</Badge>}
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div className="text-right min-w-[80px]">
                          <p className="text-muted-foreground">Current</p>
                          <p className="font-medium text-green-600">{formatCurrency(contact.buckets.current, baseCurrency)}</p>
                        </div>
                        <div className="text-right min-w-[80px]">
                          <p className="text-muted-foreground">31-60</p>
                          <p className="font-medium text-yellow-600">{formatCurrency(contact.buckets.days30, baseCurrency)}</p>
                        </div>
                        <div className="text-right min-w-[80px]">
                          <p className="text-muted-foreground">61-90</p>
                          <p className="font-medium text-orange-600">{formatCurrency(contact.buckets.days60, baseCurrency)}</p>
                        </div>
                        <div className="text-right min-w-[80px]">
                          <p className="text-muted-foreground">90+</p>
                          <p className="font-medium text-destructive">{formatCurrency(contact.buckets.days90, baseCurrency)}</p>
                        </div>
                        <div className="text-right min-w-[100px]">
                          <p className="text-muted-foreground">Total</p>
                          <p className="font-bold">{formatCurrency(contact.buckets.total, baseCurrency)}</p>
                        </div>
                      </div>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-8 mt-2 mb-4 border rounded-lg overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead>{reportType === "ar" ? "Invoice" : "Bill"} #</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Due Date</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead className="text-right">Paid</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                            <TableHead className="text-center">Days Overdue</TableHead>
                            <TableHead></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {contact.documents.map((doc) => (
                            <TableRow key={doc.id}>
                              <TableCell className="font-mono">{doc.document_number}</TableCell>
                              <TableCell>{format(new Date(doc.document_date), "MMM d, yyyy")}</TableCell>
                              <TableCell>{format(new Date(doc.due_date), "MMM d, yyyy")}</TableCell>
                              <TableCell className="text-right">{formatCurrency(doc.total, baseCurrency)}</TableCell>
                              <TableCell className="text-right">{formatCurrency(doc.amount_paid, baseCurrency)}</TableCell>
                              <TableCell className="text-right font-medium">
                                <button
                                  className="hover:underline hover:text-primary cursor-pointer disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                                  disabled={!controlAccountId}
                                  title={!controlAccountId ? `Configure ${reportType === "ar" ? "Accounts Receivable" : "Accounts Payable"} default account in Finance Settings to enable drill-down` : undefined}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!controlAccountId) return;
                                    setDrillDown({
                                      open: true,
                                      config: {
                                        title: `${contact.contact_name} — ${doc.document_number}`,
                                        accountId: controlAccountId,
                                        startDate: doc.document_date,
                                        endDate: asOfDate,
                                        sourceType: reportType === "ar" ? "invoice" : "bill",
                                      },
                                    });
                                  }}
                                >
                                  {formatCurrency(doc.balance_due, baseCurrency)}
                                </button>
                              </TableCell>
                              <TableCell className="text-center">
                                <Badge variant="outline" className={cn("text-white", getBucketColor(doc.bucket))}>
                                  {doc.days_overdue > 0 ? `${doc.days_overdue} days` : "Current"}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {reportType === "ar" && contact.email && (
                                  <Button variant="ghost" size="icon" title="Send reminder"><Mail className="h-4 w-4" /></Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <DrillDownDialog
        open={drillDown.open}
        onOpenChange={(open) => setDrillDown((prev) => ({ ...prev, open }))}
        config={drillDown.config}
      />
    </ReportPageLayout>
  );
}


export default function AgingReport() {
  return (
    
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Aging report">
      <AgingReportInner />
    </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
