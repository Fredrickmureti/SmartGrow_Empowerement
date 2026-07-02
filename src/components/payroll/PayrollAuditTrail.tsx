/**
 * PayrollAuditTrail
 * --------------------------------------------------------------------------
 * Read-only audit log surface for a payroll run. Reads from the existing
 * `audit_logs` table — populated by the R2 generic payroll trigger
 * (`log_payroll_audit`) on every status change to payroll_runs, payslips,
 * payroll_liabilities, and payroll_remittance_payments.
 *
 * RLS already gates by org + admin role; we only filter by entity scope.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldAlert } from "lucide-react";
import { format } from "date-fns";

interface Props {
  runId: string;
  payslipIds: string[];
}

interface AuditRow {
  id: string;
  created_at: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  changes_summary: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

export function PayrollAuditTrail({ runId, payslipIds }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["payroll-audit-trail", runId, payslipIds.length],
    queryFn: async (): Promise<AuditRow[]> => {
      // Pull both: rows directly tied to this run, plus rows tied to its
      // payslips. Liabilities/remittance payments are not joined here — they
      // appear in the dedicated Remittances audit surface.
      const ids = [runId, ...payslipIds];
      const { data, error } = await supabase
        .from("audit_logs")
        .select("id, created_at, user_id, action, entity_type, entity_id, entity_name, changes_summary, old_values, new_values")
        .in("entity_type", ["payroll_run", "payslip"])
        .in("entity_id", ids)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data as AuditRow[]) ?? [];
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive py-6">
        <ShieldAlert className="h-4 w-4" />
        Audit log unavailable — your role may not include audit_logs read access.
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        No audit entries yet. Status transitions on this run, its payslips, and
        related liabilities will appear here.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {data.map((row) => (
        <li
          key={row.id}
          className="text-sm border-l-2 border-muted-foreground/30 pl-3 py-1.5"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-[10px] uppercase">
              {row.entity_type.replace("_", " ")}
            </Badge>
            <span className="font-medium">{row.entity_name ?? row.entity_id?.slice(0, 8)}</span>
            <span className="text-muted-foreground text-xs">
              {format(new Date(row.created_at), "MMM d, yyyy HH:mm")}
            </span>
          </div>
          {row.changes_summary && (
            <p className="text-foreground mt-0.5 font-mono text-xs">
              {row.changes_summary}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
