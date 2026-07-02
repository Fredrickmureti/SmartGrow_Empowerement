/**
 * Turn K — Probation ending soon card.
 * Surfaces employee_contracts whose probation_end_date is within the next 30 days.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, UserCheck } from "lucide-react";

interface Row {
  id: string;
  employee_id: string;
  probation_end_date: string;
  contract_reference: string | null;
  employees?: { first_name: string; last_name: string } | null;
}

export function ProbationEndingCard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["probation-ending", currentOrg?.id, currentBusiness?.id ?? null],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("employee_contracts")
        .select("id,employee_id,probation_end_date,contract_reference,employees(first_name,last_name)")
        .eq("organization_id", currentOrg.id)
        .gte("probation_end_date", today)
        .lte("probation_end_date", in30)
        .order("probation_end_date", { ascending: true });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
    enabled: !!currentOrg?.id,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><UserCheck className="h-4 w-4" /> Probation ending (next 30 days)</CardTitle>
        <CardDescription>Confirm or extend before the date passes.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No probations ending in the next 30 days.</p>
        ) : (
          rows.slice(0, 10).map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm">
              <div className="truncate pr-2">
                <span className="font-medium">{r.employees?.first_name} {r.employees?.last_name}</span>
                <span className="text-xs text-muted-foreground ml-2">{r.contract_reference ?? ""}</span>
              </div>
              <Badge variant="outline">{r.probation_end_date}</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
