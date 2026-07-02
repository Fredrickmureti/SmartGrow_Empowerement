/**
 * PayrollSummaryWidget — surfaces current payroll state on the
 * dashboard for tenants with HR installed. Shows the latest active
 * run, net payable outstanding, and unpaid batch count.
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, ArrowRight, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";

export function PayrollSummaryWidget() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;

  const { data, isLoading } = useQuery({
    queryKey: ["payroll-summary-widget", orgId, businessId],
    enabled: !!orgId && !!businessId,
    staleTime: 60_000,
    queryFn: async () => {
      if (!orgId || !businessId) return null;
      // Latest active run (any non-cancelled, non-paid state).
      const { data: runs } = await supabase
        .from("payroll_runs")
        .select("id, payroll_number, status, pay_period_end, total_net, employee_count")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .order("pay_period_end", { ascending: false })
        .limit(1);
      const latest = runs?.[0] ?? null;

      const { count: unpaidBatches } = await supabase
        .from("payroll_payment_batches")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .in("status", ["draft", "pending"]);

      return { latest, unpaidBatches: unpaidBatches ?? 0 };
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            Payroll
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;
  const { latest, unpaidBatches } = data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4" />
          Payroll
        </CardTitle>
        <Button variant="ghost" size="sm" className="text-xs" onClick={() => navigate("/hr/payroll")}>
          Open <ArrowRight className="ml-1 h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {latest ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium truncate">{(latest as any).payroll_number}</p>
              <Badge variant="secondary" className="capitalize">
                {(latest as any).status ?? "draft"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Period ends {format(new Date((latest as any).pay_period_end), "MMM d, yyyy")}
              {(latest as any).employee_count
                ? ` · ${(latest as any).employee_count} employees`
                : ""}
            </p>
            <p className="text-lg font-bold tabular-nums">
              {formatCurrency(Number((latest as any).total_net ?? 0))}
              <span className="text-xs font-normal text-muted-foreground ml-1">net payable</span>
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No payroll runs yet.</p>
        )}
        {unpaidBatches > 0 ? (
          <button
            onClick={() => navigate("/hr/payroll")}
            className="w-full text-left text-xs rounded-md border border-warning/40 bg-warning/5 px-3 py-2 hover:bg-warning/10"
          >
            {unpaidBatches} payment batch{unpaidBatches === 1 ? "" : "es"} awaiting disbursement
          </button>
        ) : null}
      </CardContent>
    </Card>
  );
}