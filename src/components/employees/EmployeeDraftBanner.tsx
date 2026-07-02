/**
 * Banner shown at the top of an employee profile while the row is still in
 * `lifecycle_status = 'draft'`. Surfaces a single "Promote to active" CTA
 * that calls the canonical `finalize_employee_draft` RPC (the only sanctioned
 * draft → active writer; the legacy `promote_employee_draft` was retired in
 * Phase D of the Employee architecture reconstruction).
 *
 * The RPC validates the required fields (first/last name + hire date) and
 * is idempotent — if the row is already active, the call is a no-op.
 */
import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Props {
  employeeId: string;
  canPromote: boolean;
  onPromoted: () => void;
}

export function EmployeeDraftBanner({ employeeId, canPromote, onPromoted }: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const promote = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("finalize_employee_draft" as any, { p_employee_id: employeeId, p_patch: {} });
      if (error) throw error;
      toast({ title: "Employee activated", description: "This record is now visible to your team." });
      onPromoted();
    } catch (err: any) {
      toast({
        title: "Could not activate employee",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="text-sm">
          <p className="font-medium">Draft — finish setup</p>
          <p className="text-muted-foreground text-xs">
            This employee record is private to you and won't appear in the directory,
            reports, payroll, or the org chart until it is activated.
          </p>
        </div>
      </div>
      {canPromote && (
        <Button size="sm" onClick={promote} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
          Promote to active
        </Button>
      )}
    </div>
  );
}
