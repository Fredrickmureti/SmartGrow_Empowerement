/**
 * Inventory ⇄ General Ledger Reconciliation Report
 *
 * Phase 6 of the inventory reporting wave. The subledger side is no longer
 * `live warehouse_stock × current AVCO`: `reconcile_inventory_subledger_to_gl`
 * now reads `public._inventory_layer_valuation_as_of()` — the same helper
 * `report_inventory_valuation_as_of()` reads — so the reconciliation total
 * ties to the Inventory Valuation report at the same date, and any drift is
 * attributable to the General Ledger rather than to a valuation-basis
 * mismatch. The as-at date is now honest on both sides.
 *
 * The grid renders through the canonical `ReportSurface`/`ReportTable` engine
 * and exports server-built (`reportType: "inventory_gl_reconciliation"`), so
 * screen and PDF/CSV/XLSX are the same dataset by construction.
 *
 * Scope: this is an ENTITY-level integrity check — the inventory control
 * account belongs to the legal entity, not to a branch — so the page exposes
 * an as-at date only and no branch dimension.
 */

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { InventoryReconciliationCard } from "@/components/finance/InventoryReconciliationCard";
import { useInventoryReconciliation } from "@/hooks/finance/useInventoryReconciliation";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import type { ServerBuildConfig } from "@/services/reports/ReportExportService";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function exceptionsLabel(r: {
  unlayered_positions?: number;
  zero_cost_positions?: number;
  negative_qty_positions?: number;
}): string {
  const parts = [
    r.unlayered_positions ? `${r.unlayered_positions} no cost layer` : null,
    r.zero_cost_positions ? `${r.zero_cost_positions} zero cost` : null,
    r.negative_qty_positions ? `${r.negative_qty_positions} negative qty` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "none";
}

function InventoryGLReconciliationInner() {
  const [asOf, setAsOf] = useState<string>(todayISO());
  const { data: rows = [], isLoading, error } = useInventoryReconciliation(asOf);
  const { baseCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Same keys, headers and order as the server column spec
  // (`columnSpecs.ts` → `inventory_gl_reconciliation`).
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "account_code", header: "Code" },
      { key: "account_name", header: "Inventory Account" },
      { key: "subledger_value", header: "Subledger (at cost)", format: "currency", align: "right" },
      { key: "gl_closing", header: "GL Closing", format: "currency", align: "right" },
      { key: "drift", header: "Drift", format: "currency", align: "right" },
      { key: "exceptions", header: "Valuation exceptions" },
    ],
    [],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.subledger += Number(r.subledger_value ?? 0);
          acc.gl += Number(r.gl_closing ?? 0);
          acc.drift += Number(r.drift ?? 0);
          return acc;
        },
        { subledger: 0, gl: 0, drift: 0 },
      ),
    [rows],
  );

  const reportRows = useMemo<ReportRow[]>(() => {
    const detail: ReportRow[] = rows.map((r) => ({
      id: r.account_id,
      kind: "detail",
      values: {
        account_code: r.account_code ?? "",
        account_name: r.account_name ?? "",
        subledger_value: Number(r.subledger_value ?? 0),
        gl_closing: Number(r.gl_closing ?? 0),
        drift: Number(r.drift ?? 0),
        exceptions: exceptionsLabel(r),
      },
    }));

    if (detail.length === 0) return detail;

    detail.push({
      id: "grand-total",
      kind: "grandTotal",
      label: "Total",
      values: {
        account_code: "Total",
        account_name: null,
        subledger_value: totals.subledger,
        gl_closing: totals.gl,
        drift: totals.drift,
        exceptions: null,
      },
    });
    return detail;
  }, [rows, totals]);

  /**
   * Server-built export: `reportType` + org + as-at send `render-report` down
   * the same RPC, so the export cannot drift from the screen and cannot widen
   * the authorization scope.
   */
  const getExportConfig = useCallback(
    (): ServerBuildConfig => ({
      title: "Inventory ⇄ GL Reconciliation",
      reportType: "inventory_gl_reconciliation",
      organizationId: currentOrg?.id ?? undefined,
      businessId: currentBusiness?.id ?? undefined,
      branchId: null,
      asOf,
      dateFrom: asOf,
      dateTo: asOf,
      filters: { asOf },
      columns: [],
      rows: [],
      sheetName: "Inventory vs GL",
      currency: baseCurrency,
    }),
    [currentOrg?.id, currentBusiness?.id, asOf, baseCurrency],
  );

  const driftRows = useMemo(
    () => rows.filter((r) => Math.abs(r.drift) > 0.01),
    [rows],
  );

  return (
    <ReportPageLayout
      title="Inventory ⇄ GL Reconciliation"
      description="Compares the inventory subledger (stock on hand valued from the cost-layer ledger as at the reporting date) against the posted General Ledger closing balance of each configured inventory control account. Non-zero drift means a journal is missing, mis-dated, or posted elsewhere."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No inventory control account is configured for this company. Set it under Finance → Settings → Default Accounts."
      getExportConfig={getExportConfig}
      filters={
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="recon-as-of" className="text-xs">
              As at
            </Label>
            <Input
              id="recon-as-of"
              type="date"
              className="w-[170px]"
              value={asOf}
              max={todayISO()}
              onChange={(e) => setAsOf(e.target.value || todayISO())}
            />
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <ReportSurface
          title="Inventory ⇄ GL Reconciliation"
          subtitle={`Cost-layer subledger vs posted GL closing balance as at ${asOf} · ${rows.length} control account(s)`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={reportRows}
            currency={baseCurrency}
            caption="Inventory subledger versus General Ledger closing balance"
            emptyMessage="No inventory control account is configured for this company"
          />
        </ReportSurface>

        <InventoryReconciliationCard asOf={asOf} />

        {driftRows.length > 0 && (
          <div className="rounded-md border bg-card p-4 space-y-2">
            <h3 className="text-sm font-semibold">Drift drill-down</h3>
            <p className="text-xs text-muted-foreground">
              Open the GL register for any drifting account to inspect the
              journal entries that produced the closing balance.
            </p>
            <ul className="divide-y rounded border bg-background">
              {driftRows.map((r) => (
                <li
                  key={r.account_id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.account_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.account_code}
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/finance/accounts/${r.account_id}`}>
                      Open ledger
                      <ArrowRight className="h-3 w-3 ml-1" />
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ReportPageLayout>
  );
}

import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

export default function InventoryGLReconciliation() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Inventory ⇄ GL reconciliation">
        <InventoryGLReconciliationInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
