/**
 * useAttendanceDevices — hardware terminal registry (ZKTeco/Hikvision/RFID/kiosk).
 *
 * Register via SECURITY DEFINER `attendance_device_register` — the HMAC
 * secret is returned ONCE in hex form and never again exposed. Status
 * transitions go through `attendance_device_set_status`.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface AttendanceDevice {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  vendor: string;
  serial: string;
  public_id: string;
  status: "active" | "disabled" | "revoked";
  last_seen_at: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterDeviceResult {
  public_id: string;
  hmac_secret_hex: string;
}

export function useAttendanceDevices() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const { data: devices = [], isLoading } = useQuery<AttendanceDevice[]>({
    queryKey: ["attendance-devices", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let q = supabase
        .from("attendance_devices" as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false });
      if (currentBusiness?.id) q = q.eq("business_id", currentBusiness.id);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as AttendanceDevice[];
    },
    enabled: !!currentOrg?.id,
  });

  const register = useMutation({
    mutationFn: async (input: {
      vendor: string;
      serial: string;
      branch_id?: string | null;
      metadata?: Record<string, any>;
    }): Promise<RegisterDeviceResult> => {
      const { data, error } = await supabase.rpc("attendance_device_register" as any, {
        _vendor: input.vendor,
        _serial: input.serial,
        _branch_id: input.branch_id ?? null,
        _metadata: input.metadata ?? {},
      });
      if (error) throw error;
      return data as RegisterDeviceResult;
    },
    onSuccess: () => {
      toast.success("Device registered");
      qc.invalidateQueries({ queryKey: ["attendance-devices"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to register device"),
  });

  const setStatus = useMutation({
    mutationFn: async (input: { id: string; status: "active" | "disabled" | "revoked" }) => {
      const { error } = await supabase.rpc("attendance_device_set_status" as any, {
        _id: input.id,
        _status: input.status,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Device updated");
      qc.invalidateQueries({ queryKey: ["attendance-devices"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to update device"),
  });

  return {
    devices,
    isLoading,
    register: register.mutateAsync,
    isRegistering: register.isPending,
    setStatus: setStatus.mutate,
    isUpdatingStatus: setStatus.isPending,
  };
}
