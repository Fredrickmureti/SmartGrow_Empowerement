/**
 * ClosePeriodSheet — confirmation surface for locking a fiscal period.
 * Replaces the inline `<Dialog>` on `FiscalPeriods.tsx`; runs the same
 * readiness query (unposted JEs + draft invoices in range) and calls
 * the same `close_fiscal_period` RPC via `useFiscalPeriods`.
 */
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  XCircle,
} from "lucide-react";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { useFxRevaluationReadiness } from "@/hooks/finance/useFxRevaluation";

export interface PeriodToClose {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  period: PeriodToClose | null;
}

function useCloseReadiness(period: PeriodToClose | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["close-readiness", currentOrg?.id, period?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !period?.id || !currentBusiness?.id) {
        return { unpostedCount: 0, draftInvoices: 0 };
      }
      const [unposted, drafts] = await Promise.all([
        supabase
          .from("journal_entries")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("status", "draft")
          .gte("entry_date", period.start_date)
          .lte("entry_date", period.end_date),
        supabase
          .from("invoices")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("status", "draft")
          .gte("issue_date", period.start_date)
          .lte("issue_date", period.end_date),
      ]);
      return {
        unpostedCount: unposted.count || 0,
        draftInvoices: drafts.count || 0,
      };
    },
    enabled: !!currentOrg?.id && !!period?.id,
    staleTime: 30_000,
  });
}

export function ClosePeriodSheet({ open, onOpenChange, period }: Props) {
  const { closePeriod } = useFiscalPeriods();
  const { data: readiness } = useCloseReadiness(period);
  // Same server function that gates `close_fiscal_period` (ADR 0136): a period
  // cannot close while foreign-currency balances are unrevalued.
  const { data: fxReadiness } = useFxRevaluationReadiness(period?.end_date);
  const fxBlocked = !!fxReadiness?.needs_revaluation;
  const isClosing = closePeriod.isPending;

  const handleConfirm = async () => {
    if (!period) return;
    await closePeriod.mutateAsync({ periodId: period.id });
    onOpenChange(false);
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={period ? `Close period: ${period.name}` : "Close period"}
      description="Closing this period will prevent any new transactions from being posted within its date range."
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isClosing}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirm}
                disabled={isClosing || !period || fxBlocked}
              >
                {isClosing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Lock className="h-4 w-4 mr-2" />
                )}
                Close period
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-3">
        <p className="text-sm font-medium">Close readiness check</p>
        {readiness ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between p-2 rounded bg-muted/50">
              <span className="text-sm">Unposted journal entries</span>
              <span
                className={`text-sm font-medium flex items-center gap-1 ${
                  readiness.unpostedCount > 0
                    ? "text-destructive"
                    : "text-primary"
                }`}
              >
                {readiness.unpostedCount > 0 ? (
                  <XCircle className="h-3.5 w-3.5" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                {readiness.unpostedCount}
              </span>
            </div>
            <div className="flex items-center justify-between p-2 rounded bg-muted/50">
              <span className="text-sm">Draft invoices</span>
              <span
                className={`text-sm font-medium flex items-center gap-1 ${
                  readiness.draftInvoices > 0
                    ? "text-destructive"
                    : "text-primary"
                }`}
              >
                {readiness.draftInvoices > 0 ? (
                  <XCircle className="h-3.5 w-3.5" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                {readiness.draftInvoices}
              </span>
            </div>
            <div className="flex items-center justify-between p-2 rounded bg-muted/50">
              <span className="text-sm">Unrevalued foreign-currency balances</span>
              <span
                className={`text-sm font-medium flex items-center gap-1 ${
                  fxBlocked ? "text-destructive" : "text-primary"
                }`}
              >
                {fxBlocked ? (
                  <XCircle className="h-3.5 w-3.5" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                {fxReadiness?.foreign_balances.length ?? 0}
              </span>
            </div>
            {fxBlocked && (
              <Alert variant="destructive" className="mt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>FX revaluation required</AlertTitle>
                <AlertDescription className="text-xs">
                  {`This period holds ${fxReadiness?.foreign_balances.map((b) => b.currency).join(", ")} balances that have not been revalued as of ${period?.end_date}. Run FX revaluation in Accounting Controls first — the database will refuse the close until then.`}
                </AlertDescription>
              </Alert>
            )}
            {(readiness.unpostedCount > 0 || readiness.draftInvoices > 0) && (
              <Alert variant="destructive" className="mt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Items require attention</AlertTitle>
                <AlertDescription className="text-xs">
                  There are unfinalized items in this period. You can still
                  close it, but those items will be locked in their current
                  state.
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking readiness…
          </div>
        )}
      </div>
    </DetailSheet>
  );
}

export default ClosePeriodSheet;
