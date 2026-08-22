/**
 * Journal Report Page
 *
 * Lists journal entries grouped by source type with filtering.
 * Rendered by the canonical reporting engine — each journal entry becomes
 * a `section` row, its lines the details beneath, and a `subtotal` row
 * carries the entry's debit/credit totals.
 */

import { useState, useCallback, useMemo } from "react";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import {
  documentRate,
  formatDocumentAmount,
  formatRate,
  hasForeignCurrency,
  baseCurrencyNote,
  type FxLine,
} from "@/lib/reports/currencyPresentation";
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
  entry_status: string | null;
  is_reversal: boolean;
  reversal_of_number: string | null;
  journal_book: string | null;
  branch_name: string | null;
  entry_currency: string | null;
  total_debit: number;
  total_credit: number;
  lines: {
    account_code: string; account_name: string; debit: number; credit: number;
    description: string | null;
    /** Source-document amounts — supplement only, never used in arithmetic. */
    fx: FxLine;
  }[];
}

interface JournalReportData {
  entries: JournalEntry[];
  /** Entries matching the filter, before the page limit. */
  totalEntries: number;
}

/** How many entries one page of the journal shows. */
const PAGE_SIZE = 500;

function JournalReportInner() {
  const now = new Date();
  const { filters } = useReportFilters();
  // Period lives in the URL so drill-through into a source document and Back
  // return to the same journal window.
  const workspace = useReportWorkspaceState();
  const dateFrom = workspace.get("from", filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"));
  const dateTo = workspace.get("to", filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const setDateFrom = (value: string) => workspace.set({ from: value });
  const setDateTo = (value: string) => workspace.set({ to: value });
  const [page, setPage] = useState(0);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  // Shared rule: source document when there is one, otherwise the entry itself.
  const openEntryDrawer = (je: JournalEntry) => {
    const target = resolveLedgerDrillTarget({
      source_type: je.source_type,
      source_id: je.source_id,
      journal_entry_id: je.id,
    });
    if (!target) return;
    setDrawerSource(target);
    setDrawerOpen(true);
  };


  const { data, isLoading, error } = useQuery({
    queryKey: ["journal-report", currentOrg?.id, currentBusiness?.id, filters.branchId, dateFrom, dateTo, page],
    queryFn: async (): Promise<JournalReportData> => {
      if (!currentOrg?.id || !currentBusiness?.id) return { entries: [], totalEntries: 0 };
      // Server-side engine: no PostgREST 1000-row cap, strict branch scoping
      // (matching Trial Balance / General Ledger) and reversed originals kept
      // visible alongside their reversal.
      const { data: rows, error } = await supabase.rpc("get_journal_report", {
        _org_id: currentOrg.id,
        _date_from: dateFrom,
        _date_to: dateTo,
        _business_id: currentBusiness.id,
        _branch_id: filters.branchId || null,
        _source_types: null,
        _limit: PAGE_SIZE,
        _offset: page * PAGE_SIZE,
      });

      if (error) throw error;

      const byEntry = new Map<string, JournalEntry>();
      for (const r of (rows || []) as any[]) {
        let je = byEntry.get(r.entry_id);
        if (!je) {
          je = {
            id: r.entry_id,
            entry_date: r.entry_date,
            entry_number: r.entry_number,
            description: r.je_description,
            reference: r.reference,
            source_type: r.source_type,
            source_id: r.source_id,
            entry_status: r.entry_status ?? null,
            is_reversal: Boolean(r.is_reversal),
            reversal_of_number: r.reversal_of_number ?? null,
            journal_book: r.journal_book ?? null,
            branch_name: r.branch_name ?? null,
            entry_currency: r.entry_currency ?? null,
            total_debit: 0,
            total_credit: 0,
            lines: [],
          };
          byEntry.set(r.entry_id, je);
        }
        const debit = Number(r.debit) || 0;
        const credit = Number(r.credit) || 0;
        je.total_debit += debit;
        je.total_credit += credit;
        je.lines.push({
          account_code: r.account_code || "",
          account_name: r.account_name || "",
          debit,
          credit,
          description: r.line_description,
          fx: {
            entryCurrency: r.entry_currency ?? null,
            originalDebit: r.original_debit ?? null,
            originalCredit: r.original_credit ?? null,
            exchangeRate: r.exchange_rate ?? null,
          },
        });
      }

      return {
        entries: Array.from(byEntry.values()),
        totalEntries: Number((rows as any[])?.[0]?.total_entries ?? 0),
      };
    },
    enabled: !!currentOrg?.id,
  });

  const entries = data?.entries ?? [];
  const totalEntries = data?.totalEntries ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));


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
  // Multi-currency supplement: what the source document said. Debit and
  // credit remain base currency and remain the only figures that are totalled,
  // so these columns appear only when the period holds a foreign line.
  const showFxColumns = useMemo(
    () => hasForeignCurrency(entries.flatMap((e) => e.lines.map((l) => l.fx)), baseCurrency),
    [entries, baseCurrency],
  );

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "account", header: "Account", width: "w-[220px]" },
      { key: "description", header: "Description", width: "w-[260px]" },
      { key: "source", header: "Source", width: "w-[140px]" },
      ...(showFxColumns
        ? ([
            { key: "currency", header: "Currency", width: "w-[90px]" },
            { key: "doc_amount", header: "Document Amt", width: "w-[140px]", align: "right" },
            { key: "fx_rate", header: "Rate", width: "w-[100px]", align: "right" },
          ] as ReportColumn[])
        : []),
      { key: "debit", header: "Debit", format: "currency", width: "w-[130px]" },
      { key: "credit", header: "Credit", format: "currency", width: "w-[130px]" },
    ],
    [showFxColumns],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    let grandDebit = 0;
    let grandCredit = 0;
    for (const je of entries) {
      // A reversed original and its reversal are both real ledger events, so
      // the header says which is which instead of hiding the original.
      const marker = je.is_reversal
        ? ` · Reversal${je.reversal_of_number ? ` of ${je.reversal_of_number}` : ""}`
        : je.entry_status === "reversed"
          ? " · Reversed"
          : "";
      const book = je.journal_book ? ` · ${je.journal_book}` : "";
      const branch = je.branch_name ? ` · ${je.branch_name}` : "";
      out.push({
        id: `sec-${je.id}`,
        kind: "section",
        label: `${format(new Date(je.entry_date), "MMM d, yyyy")} · ${je.entry_number}${book}${branch}${marker} — ${je.description || ""}`,
      });

      for (const [idx, line] of je.lines.entries()) {
        out.push({
          id: `${je.id}-${idx}`,
          onClick: () => openEntryDrawer(je),
          values: {
            account: `${line.account_code} - ${line.account_name}`,
            description: line.description || je.description,
            source: sourceLabels[je.source_type || "manual"] || je.source_type || "Manual",
            currency: line.fx.entryCurrency && line.fx.entryCurrency !== baseCurrency ? line.fx.entryCurrency : "",
            doc_amount: formatDocumentAmount(line.fx, baseCurrency),
            fx_rate: formatRate(documentRate(line.fx, baseCurrency)),
            debit: blankIfZero(line.debit),
            credit: blankIfZero(line.credit),
          },
        });
      }

      grandDebit += je.total_debit;
      grandCredit += je.total_credit;
      out.push({
        id: `sub-${je.id}`,
        kind: "subtotal",
        label: "Entry total",
        values: { debit: je.total_debit, credit: je.total_credit },
      });
    }
    if (out.length > 0) {
      // The posting journal's proof: everything on this page balances.
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "TOTAL POSTED",
        values: { debit: grandDebit, credit: grandCredit },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, baseCurrency]);


  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Journal Report",
      reportType: "journal_report",
      companyName: currentOrg?.name || "",
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
      isEmpty={entries.length === 0}
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
        title="Journal Report"
        dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
        subtitle={[
          pageCount > 1
            ? `Entries ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + entries.length} of ${totalEntries}`
            : `${totalEntries} journal entries`,
          showFxColumns ? baseCurrencyNote(baseCurrency) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
        profile="operational"
      >
        <ReportTable
          columns={columns}
          rows={rows}
          currency={baseCurrency}
          caption="Journal report — posted entries grouped by journal entry"
          emptyMessage="No posted journal entries for the selected criteria"
        />
        {pageCount > 1 && (
          // The journal is paged rather than truncated: the page footer always
          // states which slice of the period is on screen.
          <div className="flex items-center justify-between gap-4 border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Page {page + 1} of {pageCount} · totals above cover this page only
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
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
