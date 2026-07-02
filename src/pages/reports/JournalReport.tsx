/**
 * Journal Report Page
 * 
 * Lists journal entries grouped by source type with filtering.
 */

import { useState, useCallback } from "react";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
interface JournalEntry {
  id: string;
  entry_date: string;
  entry_number: string;
  description: string;
  reference: string | null;
  source_type: string | null;
  source_id: string | null;
  total_debit: number;
  total_credit: number;
  lines: { account_code: string; account_name: string; debit: number; credit: number; description: string | null }[];
}

function JournalReportInner() {
  const now = new Date();
  const { filters } = useReportFilters();
  const [dateFrom, setDateFrom] = useState(filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  // Open the drawer on the JE's source document if available; otherwise show the JE itself.
  const openEntryDrawer = (je: JournalEntry) => {
    if (je.source_type && je.source_id && je.source_type !== "manual") {
      setDrawerSource({ type: je.source_type, id: je.source_id });
    } else {
      setDrawerSource({ type: "journal_entry", id: je.id });
    }
    setDrawerOpen(true);
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["journal-report", currentOrg?.id, currentBusiness?.id, filters.branchId, dateFrom, dateTo],
    queryFn: async (): Promise<JournalEntry[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      let q = supabase
        .from("journal_entries")
        .select(`
          id, entry_date, entry_number, description, reference, source_type, source_id, status, branch_id,
          journal_entry_lines(id, debit, credit, description, accounts(code, name))
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("status", "posted")
        .gte("entry_date", dateFrom)
        .lte("entry_date", dateTo);
      if (filters.branchId) {
        q = q.or(`branch_id.eq.${filters.branchId},branch_id.is.null`);
      }
      const { data: entries, error } = await q.order("entry_date", { ascending: false });

      if (error) throw error;

      return (entries || []).map((e: any) => ({
        id: e.id,
        entry_date: e.entry_date,
        entry_number: e.entry_number,
        description: e.description,
        reference: e.reference,
        source_type: e.source_type,
        source_id: e.source_id,
        total_debit: (e.journal_entry_lines || []).reduce((s: number, l: any) => s + (l.debit || 0), 0),
        total_credit: (e.journal_entry_lines || []).reduce((s: number, l: any) => s + (l.credit || 0), 0),
        lines: (e.journal_entry_lines || []).map((l: any) => ({
          account_code: l.accounts?.code || "",
          account_name: l.accounts?.name || "",
          debit: l.debit || 0,
          credit: l.credit || 0,
          description: l.description,
        })),
      }));
    },
    enabled: !!currentOrg?.id,
  });

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];
    for (const je of data || []) {
      rows.push({ date: je.entry_date, entry: je.entry_number, account: "", desc: je.description || "", debit: je.total_debit, credit: je.total_credit, _isHeader: true });
      for (const l of je.lines) {
        rows.push({ date: "", entry: "", account: `${l.account_code} - ${l.account_name}`, desc: l.description || "", debit: l.debit || null, credit: l.credit || null });
      }
    }
    return {
      title: "Journal Report",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: [
        { key: "date", header: "Date", width: 12 },
        { key: "entry", header: "Entry #", width: 14 },
        { key: "account", header: "Account", width: 25 },
        { key: "desc", header: "Description", width: 25 },
        { key: "debit", header: "Debit", width: 16, format: "currency", align: "right" },
        { key: "credit", header: "Credit", width: 16, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Journal Report",
    };
  }, [data, dateFrom, dateTo, currentOrg]);

  const sourceLabels: Record<string, string> = {
    invoice: "Invoice", bill: "Bill", expense: "Expense", payment: "Payment", manual: "Manual",
    bill_payment: "Bill Payment", pos_sale: "POS Sale", payroll: "Payroll", credit_note: "Credit Note",
    bank_recon: "Bank Recon", year_end_closing: "Year-End Closing", purchase_return: "Purchase Return",
    migration: "Migration", stock_adjustment: "Stock Adjustment", asset_acquisition: "Asset Acquisition",
    asset_disposal: "Asset Disposal", depreciation: "Depreciation", opening_balance: "Opening Balance",
    owner_investment: "Owner Investment", owner_drawing: "Owner Drawing", bank_transfer: "Bank Transfer",
    loan_received: "Loan Received", loan_payment: "Loan Payment",
  };

  return (
    <ReportPageLayout
      title="Journal Report"
      description="All posted journal entries with line details"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.length === 0}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['journal-report'] as const]} tooltip="Refresh journal report" />
          <SaveViewButton
            reportType="journal-report"
            currentFilters={{ dateFrom, dateTo }}
            onLoadView={(filters) => {
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
            }}
          />
        </>
      }
      filters={
        <ReportFilters dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo}>
          <ReportBranchFilter reportKind="journal" />
        </ReportFilters>
      }
    >
      <Card>
        <CardContent className="pt-6">
          <div className="text-sm text-muted-foreground mb-4">{data?.length || 0} journal entries</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Entry #</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.map((je) => (
                <>
                  {je.lines.map((line, idx) => (
                    <TableRow key={`${je.id}-${idx}`}>
                      {idx === 0 ? (
                        <>
                          <TableCell rowSpan={je.lines.length} className="align-top font-medium">
                            {format(new Date(je.entry_date), "MMM d, yyyy")}
                          </TableCell>
                          <TableCell rowSpan={je.lines.length} className="align-top font-mono text-sm">
                            {je.entry_number}
                          </TableCell>
                        </>
                      ) : null}
                      <TableCell className="font-mono text-sm">{line.account_code} - {line.account_name}</TableCell>
                      <TableCell className="text-sm">{line.description || je.description}</TableCell>
                      {idx === 0 ? (
                        <TableCell rowSpan={je.lines.length} className="align-top">
                          <Badge variant="outline">{sourceLabels[je.source_type || "manual"] || je.source_type || "Manual"}</Badge>
                        </TableCell>
                      ) : null}
                      <TableCell className="text-right">
                        <button className="hover:underline hover:text-primary cursor-pointer" onClick={() => openEntryDrawer(je)}>
                          {line.debit > 0 ? formatCurrency(line.debit, baseCurrency) : "—"}
                        </button>
                      </TableCell>
                      <TableCell className="text-right">
                        <button className="hover:underline hover:text-primary cursor-pointer" onClick={() => openEntryDrawer(je)}>
                          {line.credit > 0 ? formatCurrency(line.credit, baseCurrency) : "—"}
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <TransactionPreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        sourceType={drawerSource.type}
        sourceId={drawerSource.id}
      />
    </ReportPageLayout>
  );
}


export default function JournalReport() {
  return (
    
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Journal report">
      <JournalReportInner />
    </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
