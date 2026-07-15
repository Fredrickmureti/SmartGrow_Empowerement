/**
 * ScheduledPanel — payroll-scoped rows from `scheduled_reports`. Deep
 * links into the existing scheduled-reports configuration so the Reports
 * centre only surfaces the runs that belong to it and does not duplicate
 * the workflow.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrganization } from "@/hooks/useOrganization";

export function ScheduledPanel() {
  const { currentOrg } = useOrganization();
  const { data, isLoading } = useQuery({
    queryKey: ["payroll-scheduled-reports", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("scheduled_reports")
        .select("id, name, frequency, next_run_at, last_run_at, is_active, report_type")
        .eq("organization_id", currentOrg!.id)
        .ilike("report_type", "%payroll%")
        .order("next_run_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scheduled payroll reports</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : !data || data.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No scheduled payroll reports. Schedules can be created from the
            report viewer.
          </div>
        ) : (
          <ul className="space-y-2">
            {(data as any[]).map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.report_type} · {s.frequency}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Badge
                    variant={s.is_active ? "outline" : "secondary"}
                    className="font-normal"
                  >
                    {s.is_active ? "Active" : "Paused"}
                  </Badge>
                  {s.next_run_at && (
                    <span className="text-muted-foreground">
                      Next: {new Date(s.next_run_at).toLocaleString()}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ScheduledPanel;
