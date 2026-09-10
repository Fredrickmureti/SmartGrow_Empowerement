/**
 * Control Account Reconciliation Report
 *
 * Phase B2 — surfaces the AR / AP sub-ledger ⇄ GL control-account
 * reconciliation that already powers the `ControlAccountReconciliationCard`
 * on the Accounts Receivable / Accounts Payable pages. Reuses the single
 * `get_control_account_reconciliation` RPC (one round-trip per type) so
 * the numbers shown here are byte-identical to the cards finance staff
 * already trust.
 *
 * Future-proofed for payroll-liability and tax-payable selectors the
 * moment the underlying RPC supports those `reportType` values. Today
 * only `ar` and `ap` are wired.
 */

import { useCallback, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ControlAccountReconciliationCard } from "@/components/finance/ControlAccountReconciliationCard";
import { useControlAccountReconciliation } from "@/hooks/useControlAccountReconciliation";
import { useCurrency } from "@/hooks/useCurrency";
import type { ExportConfig, ExportColumn, ExportRow } from "@/services/reports/ReportExportService";

type ReconType = "ar" | "ap";

const TYPE_LABEL: Record<ReconType, string> = {
  ar: "Accounts Receivable",
  ap: "Accounts Payable",
};

function ControlAccountReconciliationInner() {
  const [active, setActive] = useState<ReconType>("ar");
  const recon = useControlAccountReconciliation(active);
  const { baseCurrency } = useCurrency();

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "metric", header: "Metric", width: 40 },
      { key: "amount", header: "Amount", width: 22, format: "currency", align: "right" },
    ];
    const rows: ExportRow[] = [
      { metric: `${TYPE_LABEL[active]} sub-ledger (open documents)`, amount: recon.subLedgerTotal },
      { metric: `${TYPE_LABEL[active]} GL closing balance`, amount: recon.glClosingBalance },
      { metric: "Migration opening balance", amount: recon.openingBalance },
      { metric: "Drift", amount: recon.drift },
    ];
    return {
      title: "Control Account Reconciliation",
      subtitle: `${TYPE_LABEL[active]} sub-ledger vs GL control account`,
      columns,
      rows,
      currency: baseCurrency,
    };
  }, [active, recon, baseCurrency]);

  return (
    <ReportPageLayout
      title="Control Account Reconciliation"
      description="Receivable sub-ledger balances (outstanding loan principal and unpaid client charges) compared to the GL control-account closing balance. A non-zero drift flags a missing migration journal, an unposted document, or a manual GL entry bypassing the sub-ledger. This deployment has no payables sub-ledger, so only receivables are reconciled."
      isLoading={recon.isLoading}
      error={recon.error}
      getExportConfig={getExportConfig}
    >
      <Tabs value={active} onValueChange={(v) => setActive(v as ReconType)} className="space-y-4">
        <TabsList>
          <TabsTrigger value="ar">Accounts Receivable</TabsTrigger>
        </TabsList>
        <TabsContent value="ar" className="space-y-3">
          <ControlAccountReconciliationCard reportType="ar" />
        </TabsContent>
      </Tabs>
    </ReportPageLayout>
  );
}

import { ReportFilterProvider } from "@/contexts/ReportFilterContext";

export default function ControlAccountReconciliation() {
  return (
    <ReportFilterProvider>
      <ControlAccountReconciliationInner />
    </ReportFilterProvider>
  );
}
