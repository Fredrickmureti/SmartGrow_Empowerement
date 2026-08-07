/**
 * Journal Report Page
 *
 * Lists journal entries grouped by source type with filtering.
 * Rendered by the canonical reporting engine — each journal entry becomes
 * a `section` row, its lines the details beneath, and a `subtotal` row
 * carries the entry's debit/credit totals.
 */

import { useState, useCallback, useMemo } from "react";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import {
  ReportSurface,
  ReportTable,
  blankIfZero,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

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

  const sourceLabels: Record<string, string> = {
    invoice: "Invoice", bill: "Bill", expense: "Expense", payment: "Payment", manual: "Manual",
    bill_payment: "Bill Payment", pos_sale: "POS Sale", payroll: "Payroll", credit_note: "Credit Note",
    bank_recon: "Bank Recon", year_end_closing: "Year-End Closing", purchase_return: "Purchase Return",
    migration: "Migration", stock_adjustment: "Stock Adjustment", asset_acquisition: "Asset Acquisition",
    asset_disposal: "Asset Disposal", depreciation: "Depreciation", opening_balance: "Opening Balance",
    owner_investment: "Owner Investment", owner_drawing: "Owner Drawing", bank_transfer: "Bank Transfer",
    loan_received: "Loan Received", loan_payment: "Loan Payment",
  };

  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "account", header: "Account", width: "w-[220px]" },
      { key: "description", header: "Description", width: "w-[260px]" },
      { key: "source", header: "Source", width: "w-[140px]" },
      { key: "debit", header: "Debit", format: "currency", width: "w-[130px]" },
      { key: "credit", header: "Credit", format: "currency", width: "w-[130px]" },
    ],
    [],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    for (const je of data || []) {
      out.push({
        id: `sec-${je.id}`,
        kind: "section",
        label: `${format(new Date(je.entry_date), "MMM d, yyyy")} · ${je.entry_number} — ${je.description || ""}`,
      });

      for (const [idx, line] of je.lines.entries()) {
        out.push({
          id: `${je.id}-${idx}`,
          onClick: () => openEntryDrawer(je),
          values: {
            account: `${line.account_code} - ${line.account_name}`,
            description: line.description || je.description,
            source: sourceLabels[je.source_type || "manual"] || je.source_type || "Manual",
            debit: blankIfZero(line.debit),
            credit: blankIfZero(line.credit),
          },
        });
      }

      out.push({
        id: `sub-${je.id}`,
        kind: "subtotal",
        label: "Entry total",
        values: { debit: je.total_debit, credit: je.total_credit },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Journal Report",
      reportType: "journal_report",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: "Journal Report",
      currency: baseCurrency,
    }),
    [columns, rows, dateFrom, dateTo, currentOrg, baseCurrency],
  );

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
      <ReportSurface
        companyName={currentOrg?.name || ""}
        title="Journal Report"
        dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
        subtitle={`${data?.length || 0} journal entries`}
        profile="operational"
      >
        <ReportTable
          columns={columns}
          rows={rows}
          currency={baseCurrency}
          caption="Journal report — posted entries grouped by journal entry"
          emptyMessage="No posted journal entries for the selected criteria"
        />
      </ReportSurface>
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
