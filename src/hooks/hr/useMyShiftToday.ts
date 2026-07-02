/**
 * useMyShiftToday — reads the current employee's assigned work schedule
 * row and returns the standard hours/day + schedule name so we can show
 * a meaningful "Your schedule" tile on /me/attendance.
 *
 * Only public columns are read; no new RPC required.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";

interface ScheduleSummary {
  scheduleName: string | null;
  standardHoursPerDay: number | null;
}

export function useMyShiftToday(): ScheduleSummary {
  const { currentEmployee } = useCurrentEmployee();

  const { data } = useQuery<ScheduleSummary>({
    queryKey: ["my-shift-today", currentEmployee?.id],
    enabled: !!currentEmployee?.id,
    queryFn: async () => {
      // Fetch employee → work_schedule_id, then pull the schedule row.
      const { data: emp } = await supabase
        .from("v_employees_canonical")
        .select("work_schedule_id")
        .eq("id", currentEmployee!.id)
        .maybeSingle();

      const wsId = (emp as any)?.work_schedule_id as string | null | undefined;
      if (!wsId) return { scheduleName: null, standardHoursPerDay: null };

      const { data: ws } = await supabase
        .from("work_schedules")
        .select("name, standard_hours_per_day")
        .eq("id", wsId)
        .maybeSingle();

      return {
        scheduleName: (ws as any)?.name ?? null,
        standardHoursPerDay:
          (ws as any)?.standard_hours_per_day != null
            ? Number((ws as any).standard_hours_per_day)
            : null,
      };
    },
  });

  return data ?? { scheduleName: null, standardHoursPerDay: null };
}
