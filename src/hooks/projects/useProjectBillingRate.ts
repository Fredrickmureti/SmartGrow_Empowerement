/**
 * useProjectBillingRate — the rate that will actually be applied to project
 * time, asked of the server rather than guessed on the client.
 *
 * Wave 3 (Projects domain): there is exactly one billing-rate engine,
 * `public.resolve_project_billing_rate(project, employee, explicit)`, with the
 * precedence chain: explicit entry rate -> the person's `project_members`
 * rate -> the project's `default_billable_rate` (legacy fallback
 * `hourly_rate`). The timesheet trigger and `resolve_timesheet_billing_rate`
 * both delegate to it. The UI must never mirror that chain — it reads the
 * authorized preview RPC `project_billing_rate_preview` instead, so what the
 * user is told is what the database will write.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useProjectBillingRate(
  projectId: string | null | undefined,
  employeeId: string | null | undefined,
) {
  const query = useQuery({
    queryKey: ["project-billing-rate", projectId ?? null, employeeId ?? null],
    enabled: !!projectId,
    staleTime: 60_000,
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await supabase.rpc("project_billing_rate_preview", {
        _project_id: projectId as string,
        _employee_id: employeeId ?? null,
      });
      if (error) throw error;
      const rate = Number(data ?? 0);
      return Number.isFinite(rate) && rate > 0 ? rate : null;
    },
  });

  return {
    rate: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
