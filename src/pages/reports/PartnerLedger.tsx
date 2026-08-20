/**
 * Partner Ledger Page
 *
 * Shows all transactions by customer or vendor with opening/closing
 * balances. Rendered by the canonical reporting engine as a single
 * virtualized register — a section per partner, a subtotal row per
 * partner, and a grand total at the foot.
 */

import { useState, useCallback, useMemo } from "react";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { DrillDownDialog, DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { usePartnerLedger, usePartnerLedgerReconciliation } from "@/hooks/usePartnerLedger";
import type {
  PartnerLedgerPartner,
  PartnerLedgerTransaction,
} from "@/services/finance/partnerLedger";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { format, startOfYear, endOfMonth } from "date-fns";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { Button } from "@/components/ui/button";
import { Banknote } from "lucide-react";
import { useCustomerUnappliedDeposits } from "@/hooks/useCustomerUnappliedDeposits";
import { ApplyCustomerDepositDialog } from "@/components/payments/ApplyCustomerDepositDialog";
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

/**
 * ADR 0012 R3 — per-customer "Apply Deposit" header action.
 * Only renders when the customer has cash sitting on Customer Deposits.
 * Reuses the same dialog the CustomerPayments page mounts.
 */
function PartnerLedgerDepositAction({
  contactId,
  partnerType,
}: {
  contactId: string;
  partnerType: "customer" | "supplier";
}) {
  const enabled = partnerType === "customer";
  const { totalUnapplied } = useCustomerUnappliedDeposits(enabled ? contactId : null);
  const { formatCurrency } = useCurrency();
  const [open, setOpen] = useState(false);
  if (!enabled || totalUnapplied <= 0) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Banknote className="h-4 w-4 mr-1" />
        Apply {formatCurrency(totalUnapplied)}
      </Button>
      <ApplyCustomerDepositDialog
        open={open}
        onOpenChange={setOpen}
        contactId={contactId}
      />
    </>
  );
}
/**
 * Row/partner shapes come from the canonical service — the page never
 * declares its own ledger arithmetic types.
 */
type PartnerTransaction = PartnerLedgerTransaction;
type PartnerData = PartnerLedgerPartner;


function PartnerLedgerInner() {
  const now = new Date();
  const { filters } = useReportFilters();
  // Partner side + period are URL-owned reporting scope.
  const workspace = useReportWorkspaceState();
  const partnerType: "customer" | "supplier" =
    workspace.scope.basis === "supplier" ? "supplier" : "customer";
  const setPartnerType = (value: "customer" | "supplier") => workspace.set({ basis: value });
  const dateFrom = workspace.get("from", filters.dateFrom || format(startOfYear(now), "yyyy-MM-dd"));
  const dateTo = workspace.get("to", filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const setDateFrom = (value: string) => workspace.set({ from: value });
  const setDateTo = (value: string) => workspace.set({ to: value });
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({ open: false, config: null });

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  // ADR 0029 — Single AR/AP balance engine, server-side.
  // Opening / running / closing balances are produced by
  // `finance_partner_ledger` from the same sub-ledger views the Customer
  // Ledger and Vendor Ledger consume. The page renders those numbers; it
  // never re-derives them, and it no longer pages the whole ledger into
  // the browser.
  const {
    partners: data,
    isLoading,
    error,
  } = usePartnerLedger({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id,
    branchId: filters.branchId ?? null,
    side: partnerType,
    from: dateFrom,
    to: dateTo,
  });

  // GL tie-out for the closing position, as of the period end.
  const { data: reconciliation } = usePartnerLedgerReconciliation({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id,
    branchId: filters.branchId ?? null,
    side: partnerType,
    to: dateTo,
  });


  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn<ReportRow>[]>(
    () => [
      { key: "date", header: "Date", format: "date", width: "w-[110px]" },
      { key: "entry", header: "Entry #", width: "w-[130px]" },
      { key: "description", header: "Description" },
      {
        key: "debit",
        header: "Debit",
        format: "currency",
        width: "w-[140px]",
        render: (row) => {
          const v = row.values;
          const amount = v?.debit as number | null | undefined;
          const partnerName = v?._partnerName as string | undefined;
          const entryDate = v?.date as string | undefined;
          if (!amount) return "—";
          return (
            <button
              className="hover:underline hover:text-primary cursor-pointer tabular-nums"
              onClick={(e) => {
                e.stopPropagation();
                setDrillDown({
                  open: true,
                  config: { title: `${partnerName} — Debit`, startDate: entryDate, endDate: entryDate },
                });
              }}
            >
              {formatCurrency(amount, baseCurrency)}
            </button>
          );
        },
      },
      {
        key: "credit",
        header: "Credit",
        format: "currency",
        width: "w-[140px]",
        render: (row) => {
          const v = row.values;
          const amount = v?.credit as number | null | undefined;
          const partnerName = v?._partnerName as string | undefined;
          const entryDate = v?.date as string | undefined;
          if (!amount) return "—";
          return (
            <button
              className="hover:underline hover:text-primary cursor-pointer tabular-nums"
              onClick={(e) => {
                e.stopPropagation();
                setDrillDown({
                  open: true,
                  config: { title: `${partnerName} — Credit`, startDate: entryDate, endDate: entryDate },
                });
              }}
            >
              {formatCurrency(amount, baseCurrency)}
            </button>
          );
        },
      },
      { key: "balance", header: "Balance", format: "currency", width: "w-[140px]" },
      {
        key: "_actions",
        header: "",
        width: "w-[160px]",
        exportExclude: true,
        render: (row) => {
          const v = row.values;
          if (row.kind !== "section" && !v?._depositContactId) return null;
          const contactId = v?._depositContactId as string | undefined;
          if (!contactId) return null;
          return <PartnerLedgerDepositAction contactId={contactId} partnerType={partnerType} />;
        },
      },
    ],
    [baseCurrency, formatCurrency, partnerType],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    const grand = { debit: 0, credit: 0 };
    for (const p of data || []) {
      out.push({
        id: `sec-${p.contact_id}`,
        kind: "section",
        label: p.contact_name,
        values: { _depositContactId: p.contact_id },
      });
      out.push({
        id: `open-${p.contact_id}`,
        values: { description: "Opening Balance", balance: p.opening_balance },
      });
      for (const t of p.transactions) {
        out.push({
          id: t.id,
          values: {
            date: t.entry_date,
            entry: t.entry_number,
            description: t.description,
            debit: blankIfZero(t.debit),
            credit: blankIfZero(t.credit),
            balance: t.running_balance,
            _partnerName: p.contact_name,
          },
        });
      }
      out.push({
        id: `sub-${p.contact_id}`,
        kind: "subtotal",
        label: "Total",
        values: { debit: p.total_debit, credit: p.total_credit, balance: p.closing_balance },
      });
      grand.debit += p.total_debit;
      grand.credit += p.total_credit;
    }
    if (out.length > 0) {
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "GRAND TOTAL",
        values: { debit: grand.debit, credit: grand.credit },
      });
    }
    return out;
  }, [data]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: `${partnerType === "customer" ? "Customer" : "Supplier"} Ledger`,
      reportType: "partner_ledger",
      companyName: currentOrg?.name || "",
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: "Partner Ledger",
      currency: baseCurrency,
    }),
    [columns, rows, partnerType, dateFrom, dateTo, currentOrg, baseCurrency],
  );

  return (
    <ReportPageLayout
      title="Partner Ledger"
      description="Transaction history by customer or supplier"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.length === 0}
      emptyMessage={`No transactions found for ${partnerType}s`}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['partner-ledger'] as const]} tooltip="Refresh partner ledger" />
          <SaveViewButton
            reportType="partner-ledger"
            currentFilters={{ partnerType, dateFrom, dateTo }}
            onLoadView={(filters) => {
              if (filters.partnerType) setPartnerType(filters.partnerType);
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
            }}
          />
        </>
      }
      filters={
        <ReportFilters dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo}>
          <ReportBranchFilter reportKind="partner_ledger" />
          <Tabs value={partnerType} onValueChange={(v) => setPartnerType(v as "customer" | "supplier")}>
            <TabsList>
              <TabsTrigger value="customer">Customers</TabsTrigger>
              <TabsTrigger value="supplier">Suppliers</TabsTrigger>
            </TabsList>
          </Tabs>
        </ReportFilters>
      }
    >
      <ReportSurface
        title={`${partnerType === "customer" ? "Customer" : "Supplier"} Ledger`}
        dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
        profile="operational"
      >
        <ReportTable
          columns={columns}
          rows={rows}
          currency={baseCurrency}
          caption="Partner ledger — transaction detail and running balance by partner"
          emptyMessage={`No transactions found for ${partnerType}s`}
        />
      </ReportSurface>

      <DrillDownDialog
        open={drillDown.open}
        onOpenChange={(open) => setDrillDown((prev) => ({ ...prev, open }))}
        config={drillDown.config}
      />
    </ReportPageLayout>
  );
}

export default function PartnerLedger() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Partner Ledger">
        <PartnerLedgerInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
