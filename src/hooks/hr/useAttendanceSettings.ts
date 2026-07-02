import { normalizeError } from "@/services/resilience";
/**
 * useAttendanceSettings — read/update attendance_settings (business-scoped).
 *
 * One row per (organization_id, business_id) — created on first read.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface AttendanceSettings {
  id: string;
  organization_id: string;
  business_id: string | null;
  late_grace_minutes: number;
  overtime_threshold_hours: number;
  overtime_multiplier: number;
  auto_checkout_after_hours: number;
  allow_self_correction: boolean;
  require_manager_approval_for_correction: boolean;
  kiosk_pin_required: boolean;
  block_clock_in_on_approved_leave: boolean;
  missing_checkout_cron_enabled: boolean;
  // Phase B — anti-fraud policy flags (server-enforced inside clock RPCs)
  geofence_required: boolean;
  selfie_required: boolean;
  device_binding_required: boolean;
  allow_offline_clock: boolean;
  max_clock_drift_minutes: number;
  // Phase 2/3 — shift window, OT preapproval, fraud, holiday auto-stamp
  enforce_shift_window: boolean;
  early_clock_in_minutes: number;
  late_clock_in_minutes: number;
  require_ot_preapproval: boolean;
  max_speed_kmh: number;
  min_clock_interval_seconds: number;
  holiday_auto_stamp: boolean;
  impossible_travel_action: "flag" | "deny";
  require_approval_for_payroll: boolean;
  require_late_reason: boolean;
  device_trust_action: "flag" | "deny" | "allow";
}

const DEFAULTS: Omit<AttendanceSettings, "id" | "organization_id" | "business_id"> = {
  late_grace_minutes: 10,
  overtime_threshold_hours: 8,
  overtime_multiplier: 1.5,
  auto_checkout_after_hours: 16,
  allow_self_correction: true,
  require_manager_approval_for_correction: true,
  kiosk_pin_required: true,
  block_clock_in_on_approved_leave: true,
  missing_checkout_cron_enabled: true,
  geofence_required: false,
  selfie_required: false,
  device_binding_required: false,
  allow_offline_clock: false,
  max_clock_drift_minutes: 15,
  enforce_shift_window: false,
  early_clock_in_minutes: 30,
  late_clock_in_minutes: 120,
  require_ot_preapproval: false,
  max_speed_kmh: 200,
  min_clock_interval_seconds: 30,
  holiday_auto_stamp: false,
  impossible_travel_action: "flag",
  require_approval_for_payroll: false,
  require_late_reason: false,
  device_trust_action: "flag",
};


export function useAttendanceSettings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery<AttendanceSettings | null>({
    queryKey: ["attendance-settings", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return null;
      const { data, error } = await supabase
        .from("attendance_settings")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .maybeSingle();
      if (error) throw error;
      if (data) return data as unknown as AttendanceSettings;
      // Auto-seed
      const { data: created, error: insErr } = await supabase
        .from("attendance_settings")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          ...DEFAULTS,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      return created as unknown as AttendanceSettings;
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const update = useMutation({
    mutationFn: async (patch: Partial<AttendanceSettings>) => {
      if (!settings?.id) throw new Error("Settings not loaded");
      const { error } = await supabase
        .from("attendance_settings")
        .update(patch)
        .eq("id", settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Attendance settings updated");
      qc.invalidateQueries({ queryKey: ["attendance-settings"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to update settings"),
  });

  return { settings, isLoading, update: update.mutate, isUpdating: update.isPending };
}
