/**
 * useTalentSettings — read/write the per-org Talent governance defaults
 * (`public.talent_settings`). Read is open to any user in the org (feeds
 * client-side branching for approval gates & reminder cadence); write is
 * gated by RLS to admin/owner/super_admin.
 *
 * Consumers (merit, calibration, dev-plan activation, HR admin surfaces)
 * should read this once and branch: e.g. `merit_requires_approval` decides
 * whether the merit apply hook opens an approval request or short-circuits
 * to `talent_merit_apply` directly.
 *
 * A single row is guaranteed to exist per organization (seeded by a
 * migration trigger on `organizations` insert). If the row is missing for
 * any reason, the hook returns the same defaults the migration seeds so
 * the UI never blocks.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeError } from "@/services/resilience";

export interface TalentSettings {
  organization_id: string;
  default_review_scale_min: number;
  default_review_scale_max: number;
  default_competency_scale_id: string | null;
  merit_requires_approval: boolean;
  calibration_requires_approval: boolean;
  devplan_activation_requires_approval: boolean;
  goal_checkin_reminder_days: number;
  oneonone_reminder_hours: number;
  action_item_reminder_days: number;
  hipo_potential_threshold: number;
  hipo_performance_threshold: number;
  require_manager_ack_on_review: boolean;
  auto_close_cycles: boolean;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

const FALLBACK: Omit<TalentSettings, "organization_id" | "updated_by" | "updated_at" | "created_at"> = {
  default_review_scale_min: 1,
  default_review_scale_max: 5,
  default_competency_scale_id: null,
  merit_requires_approval: true,
  calibration_requires_approval: false,
  devplan_activation_requires_approval: false,
  goal_checkin_reminder_days: 0,
  oneonone_reminder_hours: 24,
  action_item_reminder_days: 1,
  hipo_potential_threshold: 3,
  hipo_performance_threshold: 3,
  require_manager_ack_on_review: true,
  auto_close_cycles: false,
};

export function useTalentSettings() {
  const { currentOrg } = useOrganization();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["talent-settings", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return null;
      const { data, error } = await (supabase.from("talent_settings") as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .maybeSingle();
      if (error) throw error;
      if (data) return data as TalentSettings;
      // Defensive: return in-memory fallback (do NOT insert client-side —
      // RLS restricts writes to admins; the trigger seeds it on org create).
      return {
        organization_id: currentOrg.id,
        updated_by: null,
        updated_at: new Date(0).toISOString(),
        created_at: new Date(0).toISOString(),
        ...FALLBACK,
      } as TalentSettings;
    },
    enabled: !!currentOrg?.id,
    staleTime: 60_000,
  });

  const update = useMutation({
    mutationFn: async (patch: Partial<TalentSettings>) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await (supabase.from("talent_settings") as any)
        .update({ ...patch, updated_by: user?.id ?? null })
        .eq("organization_id", currentOrg.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["talent-settings"] });
      toast.success("Talent settings saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return { settings, isLoading, update };
}
