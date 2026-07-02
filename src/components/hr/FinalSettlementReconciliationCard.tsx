/**
 * Turn K — Final settlement reconciliation surface, reads the
 * v_termination_payout_reconciliation view (already present).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Receipt } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

export function FinalSettlementReconciliationCard() {
  const { currentOrg } = useOrganization();
  const { formatCurrency } = useCurrency();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["v-termination-payout-reconciliation", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("v_termination_payout_reconciliation")
        .select("*")
        .eq("organization_id", currentOrg.id);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!currentOrg?.id,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Receipt className="h-4 w-4" /> Final settlement reconciliation</CardTitle>
        <CardDescription>Pending termination payouts not yet drained into payroll.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">All termination payouts are reconciled.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {rows.slice(0, 20).map((r: any, i) => (
              <li key={i} className="flex justify-between border-b py-1">
                <span className="truncate pr-2">{r.employee_name ?? r.employee_id?.slice?.(0, 8) ?? "—"}</span>
                <span className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">{r.status ?? "pending"}</Badge>
                  <span className="font-medium">{formatCurrency(Number(r.amount ?? r.outstanding ?? 0))}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
