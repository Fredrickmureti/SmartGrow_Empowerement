import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowRight } from "lucide-react";

type ReconRow = {
  payout_id: string;
  employee_id: string;
  payout_kind: string;
  payout_amount: number | null;
  payout_status: string;
  amount_variance: number | null;
  status_match: string;
  days_open: number;
};

/**
 * Wave 2.5 surface — orphans and variances from
 * v_termination_payout_reconciliation.
 */
export function TerminationPayoutReconciliationCard() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();

  const { data, isLoading } = useQuery({
    queryKey: ["termination-payout-recon", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_termination_payout_reconciliation" as never)
        .select(
          "payout_id, employee_id, payout_kind, payout_amount, payout_status, amount_variance, status_match, days_open",
        )
        .eq("organization_id", currentOrg!.id)
        .in("status_match", ["pending", "pending_run_open", "orphan", "consumed_unposted", "reversed"])
        .order("days_open", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as ReconRow[];
    },
  });

  if (isLoading) return null;
  const rows = data ?? [];
  if (rows.length === 0) return null;

  const orphans = rows.filter((r) => r.status_match === "orphan").length;
  const pendingRunOpen = rows.filter((r) => r.status_match === "pending_run_open").length;
  const stillPending = rows.filter((r) => r.status_match === "pending").length;
  const variances = rows.filter(
    (r) => r.amount_variance !== null && Math.abs(Number(r.amount_variance)) > 0.01,
  ).length;

  return (
    <Card className="border-l-4 border-l-amber-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <CardTitle className="text-base">Termination Payout Reconciliation</CardTitle>
          </div>
          <Badge variant="secondary">{rows.length} open</Badge>
        </div>
        <CardDescription>Queued exit payouts awaiting a final-settlement payroll run.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Pending" value={stillPending} />
          <Stat label="Run open" value={pendingRunOpen} />
          <Stat label="Orphans" value={orphans} accent={orphans > 0} />
          <Stat label="Variances" value={variances} accent={variances > 0} />
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => navigate("/hr/payroll?tab=termination")}>
            Review payouts <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="text-center p-3 rounded-lg bg-muted/50">
      <div className={`text-2xl font-bold ${accent ? "text-amber-600" : ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
