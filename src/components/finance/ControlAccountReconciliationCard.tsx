import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, Settings2 } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { useControlAccountReconciliation } from "@/hooks/useControlAccountReconciliation";
import { CalloutCard } from "@/components/common/CalloutCard";

interface ControlAccountReconciliationCardProps {
  reportType: "ar" | "ap";
  /** Optional click handler when user wants to drill into the control account ledger */
  onViewLedger?: () => void;
}

/**
 * ControlAccountReconciliationCard
 *
 * Industry-grade ERP integrity surface that compares the GL control account
 * closing balance vs the sum of open AR/AP sub-ledger documents. Shows green
 * "in sync" state when matched and a destructive drift warning when not.
 *
 * This is the reference implementation of the ERP's composite/exception card
 * and now renders the shared `CalloutCard` primitive, so Warehouse operational
 * callouts are literally the same component rather than a look-alike.
 */
export function ControlAccountReconciliationCard({
  reportType,
  onViewLedger,
}: ControlAccountReconciliationCardProps) {
  const { formatCurrency } = useCurrency();
  const recon = useControlAccountReconciliation(reportType);

  const label = reportType === "ar" ? "Accounts Receivable" : "Accounts Payable";
  const subLedgerLabel = reportType === "ar" ? "Open Invoices" : "Open Bills";

  if (!recon.isConfigured) {
    return (
      <CalloutCard
        tone="warning"
        icon={<Settings2 className="h-5 w-5" />}
        title={`${label} control account not configured`}
        description={`Set the default ${label} account to enable sub-ledger reconciliation.`}
        to="/finance/settings"
        actionLabel="Configure"
      />
    );
  }

  if (recon.isLoading) {
    return <CalloutCard loading title="" />;
  }

  if (recon.hasDrift) {
    return (
      <CalloutCard
        tone="danger"
        icon={<AlertTriangle className="h-5 w-5" />}
        title={`${label} control out of sync`}
        description="Sub-ledger total does not match GL control account closing balance."
        badge={
          <Badge variant="destructive">
            Drift {formatCurrency(Math.abs(recon.drift))}
          </Badge>
        }
        metrics={[
          { label: subLedgerLabel, value: formatCurrency(recon.subLedgerTotal) },
          { label: `GL ${label}`, value: formatCurrency(recon.glClosingBalance) },
          { label: "Drift", value: formatCurrency(recon.drift), tone: "danger", wide: true },
        ]}
        actionLabel={onViewLedger ? "View control account ledger" : undefined}
        onAction={onViewLedger}
      />
    );
  }

  return (
    <CalloutCard
      tone="success"
      icon={<CheckCircle2 className="h-5 w-5" />}
      title={`${label} reconciles with general ledger`}
      description={`${subLedgerLabel}: ${formatCurrency(recon.subLedgerTotal)} = GL closing balance`}
      badge={
        <Badge
          variant="outline"
          className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
        >
          In sync
        </Badge>
      }
    />
  );
}
