import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, Settings2, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useCurrency } from "@/hooks/useCurrency";
import { useControlAccountReconciliation } from "@/hooks/useControlAccountReconciliation";
import { Skeleton } from "@/components/ui/skeleton";

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
      <Card className="border-l-4 border-l-amber-500 bg-amber-500/5">
        <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Settings2 className="h-5 w-5 text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-medium">{label} control account not configured</p>
              <p className="text-xs text-muted-foreground">
                Set the default {label} account to enable sub-ledger reconciliation.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to="/finance/settings">
              Configure
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (recon.isLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (recon.hasDrift) {
    return (
      <Card className="border-l-4 border-l-destructive bg-destructive/5">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
              <div>
                <p className="text-sm font-medium">{label} control out of sync</p>
                <p className="text-xs text-muted-foreground">
                  Sub-ledger total does not match GL control account closing balance.
                </p>
              </div>
            </div>
            <Badge variant="destructive">Drift {formatCurrency(Math.abs(recon.drift))}</Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div className="rounded-md border bg-background p-2">
              <p className="text-muted-foreground">{subLedgerLabel}</p>
              <p className="font-semibold tabular-nums">{formatCurrency(recon.subLedgerTotal)}</p>
            </div>
            <div className="rounded-md border bg-background p-2">
              <p className="text-muted-foreground">GL {label}</p>
              <p className="font-semibold tabular-nums">{formatCurrency(recon.glClosingBalance)}</p>
            </div>
            <div className="rounded-md border bg-background p-2 col-span-2 sm:col-span-1">
              <p className="text-muted-foreground">Drift</p>
              <p className="font-semibold tabular-nums text-destructive">
                {formatCurrency(recon.drift)}
              </p>
            </div>
          </div>
          {onViewLedger && (
            <Button variant="outline" size="sm" onClick={onViewLedger}>
              View control account ledger
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-emerald-500 bg-emerald-500/5">
      <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <div>
            <p className="text-sm font-medium">{label} reconciles with general ledger</p>
            <p className="text-xs text-muted-foreground">
              {subLedgerLabel}: {formatCurrency(recon.subLedgerTotal)} = GL closing balance
            </p>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
          In sync
        </Badge>
      </CardContent>
    </Card>
  );
}
