/**
 * Aging Report Page
 * 
 * Track overdue receivables and payables with export functionality.
 * Rendered by the canonical reporting engine (`@/design-system/reports`).
 */

import { useState, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { DrillDownDialog, DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
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
import type { ExportConfig } from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";

function AgingReportInner() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Reporting scope (AR/AP side + as-of date) is URL-owned so drill-down and
  // Back preserve the exact ageing view the user was investigating.
  const workspace = useReportWorkspaceState();
  const legacyType = (searchParams.get("type") || "").toLowerCase();
  const legacyTypeSide: "ar" | "ap" | null =
    legacyType === "payable" || legacyType === "ap"
      ? "ap"
      : legacyType === "receivable" || legacyType === "ar"
        ? "ar"
        : null;
  const reportType: "ar" | "ap" =
    workspace.scope.basis === "ap" ? "ap" : legacyTypeSide ?? "ar";
  const setReportType = (value: "ar" | "ap") => workspace.set({ basis: value });
  const legacyAsOf =
    searchParams.get("as_of") ||
    searchParams.get("date_to") ||
    searchParams.get("dateTo");
  const asOfDate = workspace.get(
    "asOf",
    legacyAsOf || format(new Date(), "yyyy-MM-dd"),
  );
  const setAsOfDate = (value: string) => workspace.set({ asOf: value });
  const [expandedContacts, setExpandedContacts] = useState<Set<string>>(new Set());
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({ open: false, config: null });

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

  // ── One column + row declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn[]>(
    () => [
      {
        key: "contact",
        header: reportType === "ar" ? "Customer" : "Supplier",
        width: "w-[280px]",
        sticky: true,
        render: (row) => {
          const r = row as unknown as ReportRow;
          const isExpanded = expandedContacts.has(r.id);
          return (
            <div className="flex items-center gap-2">
              {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
              <span
                className="font-medium text-primary hover:underline cursor-pointer"
                onClick={(e) => { e.stopPropagation(); navigate(`/contacts-app/profile?id=${r.id}`); }}
              >
                {r.label}
              </span>
              {r.tone === "danger" && <Badge variant="destructive" className="ml-1">90+ days</Badge>}
            </div>
          );
        },
      },
      { key: "current", header: "Current", format: "currency", width: "w-[130px]" },
      { key: "days30", header: "31-60 Days", format: "currency", width: "w-[130px]" },
      { key: "days60", header: "61-90 Days", format: "currency", width: "w-[130px]" },
      { key: "days90", header: "90+ Days", format: "currency", width: "w-[130px]" },
      { key: "total", header: "Total", format: "currency", width: "w-[140px]" },
    ],
    [reportType, expandedContacts, navigate],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const contacts = data?.contacts || [];
    const out: ReportRow[] = contacts.map((contact) => ({
      id: contact.contact_id,
      label: contact.contact_name,
      tone: contact.buckets.days90 > 0 ? "danger" : "default",
      onClick: () => toggleContact(contact.contact_id),
      values: {
        current: contact.buckets.current || null,
        days30: contact.buckets.days30 || null,
        days60: contact.buckets.days60 || null,
        days90: contact.buckets.days90 || null,
        total: contact.buckets.total,
      },
    }));

    if (out.length > 0) {
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "TOTAL",
        values: {
          current: data?.summary.current || 0,
          days30: data?.summary.days30 || 0,
          days60: data?.summary.days60 || 0,
          days90: data?.summary.days90 || 0,
          total: data?.summary.total || 0,
        },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, expandedContacts]);

  const documentColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "document_number", header: reportType === "ar" ? "Invoice #" : "Bill #", width: "w-[140px]" },
      { key: "document_date", header: "Date", format: "date", width: "w-[110px]" },
      { key: "due_date", header: "Due Date", format: "date", width: "w-[110px]" },
      { key: "total", header: "Amount", format: "currency", width: "w-[130px]" },
      { key: "amount_paid", header: "Paid", format: "currency", width: "w-[130px]" },
      { key: "balance_due", header: "Balance", format: "currency", width: "w-[130px]" },
      {
        key: "bucket",
        header: "Days Overdue",
        align: "center",
        width: "w-[130px]",
        render: (row) => {
          const r = row as unknown as ReportRow;
          const bucket = String(r.values?.bucket ?? "");
          const daysOverdue = Number(r.values?.days_overdue ?? 0);
          return (
            <Badge variant="outline" className={cn("text-white", getBucketColor(bucket))}>
              {daysOverdue > 0 ? `${daysOverdue} days` : "Current"}
            </Badge>
          );
        },
      },
      {
        key: "actions",
        header: "",
        exportExclude: true,
        render: (row) => {
          const r = row as unknown as ReportRow;
          const hasEmail = !!r.values?.hasEmail;
          if (reportType !== "ar" || !hasEmail) return null;
          return <Button variant="ghost" size="icon" title="Send reminder"><Mail className="h-4 w-4" /></Button>;
        },
      },
    ],
    [reportType],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    return {
      title: reportType === "ar" ? "Accounts Receivable Aging" : "Accounts Payable Aging",
      companyName: currentOrg?.name || "",
      reportType: reportType === "ar" ? "invoice_aging" : "aged_payables",
      asOf: format(new Date(asOfDate), "MMMM d, yyyy"),
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: reportType === "ar" ? "AR Aging" : "AP Aging",
      currency: baseCurrency,
    };
  }, [columns, rows, reportType, asOfDate, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Aging Report"
      description="Track overdue receivables and payables"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.contacts.length === 0}
      emptyState={{
        kind: "no_data",
        title: `No outstanding ${reportType === "ar" ? "receivables" : "payables"}`,
        message:
          "Every document in scope is settled as at the selected date, or no documents exist yet for this business and branch.",
      }}
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

      {/* ADR 0136: an incomplete total must say so rather than look complete. */}
      {(data?.unconvertibleDocumentCount || 0) > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <span className="font-medium text-destructive">Total is incomplete.</span>{" "}
          {data?.unconvertibleDocumentCount} document(s) are in a currency with no exchange rate on file
          as at this date and are excluded from the buckets below.{" "}
          <Link to="/settings/company?tab=currency" className="underline underline-offset-2">
            Add a rate
          </Link>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Current</CardTitle>
            <CardDescription>0-30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-green-600 tabular-nums whitespace-nowrap">
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
            <p className="stat-value text-yellow-600 tabular-nums whitespace-nowrap">
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
            <p className="stat-value text-orange-600 tabular-nums whitespace-nowrap">
              {formatCurrency(data?.summary.days60 || 0, baseCurrency)}
            </p>
            {totalAmount > 0 && <Progress value={((data?.summary.days60 || 0) / totalAmount) * 100} className="h-2 mt-2" />}
          </CardContent>
        </Card>
        <Card className={data?.summary.days90 && data.summary.days90 > 0 ? "border-destructive" : ""}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium">90+ Days</CardTitle>
              {(data?.summary.days90 || 0) > 0 && <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />}
            </div>
            <CardDescription>Seriously Overdue</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="stat-value text-destructive tabular-nums whitespace-nowrap">
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
            <p className="stat-value tabular-nums whitespace-nowrap">{formatCurrency(data?.summary.total || 0, baseCurrency)}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {data?.contacts.length || 0} {reportType === "ar" ? "customers" : "suppliers"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Aging by contact, driven by the shared reporting engine. Click a row to expand documents. */}
      <ReportSurface
        title={reportType === "ar" ? "Accounts Receivable Aging" : "Accounts Payable Aging"}
        asOfDate={`As of ${format(new Date(asOfDate), "MMMM d, yyyy")}`}
        subtitle={filters.branchId ? "Branch scoped" : undefined}
        profile="operational"
      >
        <ReportTable
          columns={columns}
          rows={rows}
          currency={baseCurrency}
          caption={`${reportType === "ar" ? "Customer" : "Supplier"} aging detail`}
          emptyMessage={`No outstanding ${reportType === "ar" ? "receivables" : "payables"}`}
        />
      </ReportSurface>

      {/* Expanded contact document detail */}
      {(data?.contacts || [])
        .filter((c) => expandedContacts.has(c.contact_id))
        .map((contact) => {
          const docRows: ReportRow[] = contact.documents.map((doc) => ({
            id: doc.id,
            onClick: () => {
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
            },
            values: {
              document_number: doc.document_number,
              document_date: doc.document_date,
              due_date: doc.due_date,
              total: doc.total,
              amount_paid: doc.amount_paid,
              balance_due: doc.balance_due === null ? "No rate on file" : doc.balance_due,
              bucket: doc.bucket,
              days_overdue: doc.days_overdue,
              hasEmail: !!contact.email,
            },
          }));
          return (
            <Card key={contact.contact_id}>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">{contact.contact_name} — {reportType === "ar" ? "Invoices" : "Bills"}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ReportTable
                  columns={documentColumns}
                  rows={docRows}
                  currency={baseCurrency}
                  caption={`${contact.contact_name} document detail`}
                  emptyMessage="No documents"
                />
              </CardContent>
            </Card>
          );
        })}

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
