/**
 * Inventory ⇄ General Ledger Reconciliation Report
 *
 * Phase B1 — wraps the already-shipped `reconcile_inventory_subledger_to_gl`
 * RPC behind a dedicated, exportable report surface. The reconciliation
 * card itself (used inside Finance Settings) is reused verbatim so logic
 * lives in exactly one place; this page adds:
 *
 *  - Report-page chrome (title, branch filter, export buttons, view log).
 *  - PDF/CSV export of the drift grid.
 *  - A drill-down link into the GL register for any drifting account.
 *
 * Branch filter is rendered by ReportPageLayout but ignored by the RPC —
 * inventory subledger ⇄ GL reconciliation is an entity-level integrity
 * check (assets belong to the legal entity, not a branch). The filter
 * stays visible for layout consistency; this is documented behaviour.
 */

import { useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { InventoryReconciliationCard } from "@/components/finance/InventoryReconciliationCard";
import { useInventoryReconciliation } from "@/hooks/finance/useInventoryReconciliation";
import { useCurrency } from "@/hooks/useCurrency";
import type { ExportConfig, ExportColumn, ExportRow } from "@/services/reports/ReportExportService";

export default function InventoryGLReconciliation() {
  const { data: rows = [], isLoading, error } = useInventoryReconciliation();
  const { baseCurrency } = useCurrency();

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "account_code", header: "Code", width: 16 },
      { key: "account_name", header: "Inventory Account", width: 40 },
      { key: "subledger_value", header: "Subledger (at cost)", width: 22, format: "currency", align: "right" },
      { key: "gl_closing", header: "GL Closing", width: 22, format: "currency", align: "right" },
      { key: "drift", header: "Drift", width: 22, format: "currency", align: "right" },
    ];
    const exportRows: ExportRow[] = rows.map((r) => ({
      account_code: r.account_code,
      account_name: r.account_name,
      subledger_value: r.subledger_value,
      gl_closing: r.gl_closing,
      drift: r.drift,
    }));
    return {
      title: "Inventory ⇄ GL Reconciliation",
      subtitle: "Subledger (Σ warehouse_stock × cost_price) vs General Ledger closing balance",
      columns,
      rows: exportRows,
      currency: baseCurrency,
    };
  }, [rows, baseCurrency]);

  const driftRows = useMemo(
    () => rows.filter((r) => Math.abs(r.drift) > 0.01),
    [rows],
  );

  return (
    <ReportPageLayout
      title="Inventory ⇄ GL Reconciliation"
      description="Compares the inventory subledger against the General Ledger closing balance of each configured inventory control account. Non-zero drift indicates a missing opening, revaluation, or adjustment journal."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No inventory control account is configured for this organization. Set it under Finance → Settings → Default Accounts."
      getExportConfig={getExportConfig}
    >
      <div className="space-y-4">
        <InventoryReconciliationCard />

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
