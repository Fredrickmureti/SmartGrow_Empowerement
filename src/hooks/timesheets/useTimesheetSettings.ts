import { normalizeError } from "@/services/resilience";
/**
 * useTimesheetSettings — reads and updates the org-level timesheet_settings row.
 * Every flag returned here is enforced either in the entry form, the hook, or
 * server-side triggers / RPCs. There are NO decorative settings.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { toast } from "sonner";

export interface TimesheetSettings {
  id: string;
  organization_id: string;
  submission_frequency: "daily" | "weekly" | "biweekly" | "monthly";
  week_start_day: number; // 0=Sun..6=Sat
  require_project: boolean;
  require_task: boolean;
  require_approval: boolean;
  default_billable: boolean;
  minimum_hours_per_day: number | null;
  maximum_hours_per_day: number | null;
  overtime_threshold_daily: number | null;
  overtime_threshold_weekly: number | null;
  allow_self_approval: boolean;
  block_on_time_off_overlap: boolean;
}

export function useTimesheetSettings() {
  const { currentOrg } = useOrganization();
  const [settings, setSettings] = useState<TimesheetSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetch = useCallback(async () => {
    if (!currentOrg) { setIsLoading(false); return; }
    setIsLoading(true);
    const { data, error } = await supabase
      .from("timesheet_settings")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .maybeSingle();
    if (error) {
      console.error(error);
    } else {
      setSettings((data as unknown as TimesheetSettings) || null);
    }
    setIsLoading(false);
  }, [currentOrg?.id]);

  useEffect(() => { fetch(); }, [fetch]);

  const save = async (patch: Partial<TimesheetSettings>) => {
    if (!currentOrg) return;
    const payload = { organization_id: currentOrg.id, ...patch };
    const { error } = settings
      ? await supabase.from("timesheet_settings").update(patch).eq("id", settings.id)
      : await supabase.from("timesheet_settings").insert(payload as any);
    if (error) {
      toast.error(normalizeError(error).message);
      return;
    }
    toast.success("Timesheet settings saved");
    await fetch();
  };

  return { settings, isLoading, save, refresh: fetch };
}
