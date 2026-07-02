import { normalizeError } from "@/services/resilience";
/**
 * useKioskClock — kiosk PIN clock-in/out wrapper.
 *
 * Backed by `attendance_kiosk_clock(_organization_id, _branch_id,
 * _employee_number, _pin)`. The RPC handles PIN verification and
 * toggles between clock-in/clock-out automatically server-side.
 */
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export function useKioskClock(orgId: string | undefined, branchId: string | undefined) {
  return useMutation({
    mutationFn: async ({
      employeeNumber,
      pin,
    }: {
      employeeNumber: string;
      pin: string;
    }) => {
      if (!orgId) throw new Error("Kiosk not configured");
      if (!branchId) throw new Error("Branch is required for kiosk mode");
      const { data, error } = await supabase.rpc("attendance_kiosk_clock", {
        _organization_id: orgId,
        _branch_id: branchId,
        _employee_number: employeeNumber,
        _pin: pin,
      });
      if (error) throw new Error(error.message || "Invalid PIN or employee number");
      return data;
    },
    onSuccess: (data: any) => {
      const action = data?.action || "recorded";
      const name = data?.employee_name ? ` — ${data.employee_name}` : "";
      toast.success(`Clock ${action}${name}`);
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });
}
