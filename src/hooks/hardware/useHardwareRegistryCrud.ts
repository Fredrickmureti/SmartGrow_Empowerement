/**
 * useHardwareRegistryCrud — Wave 8.
 *
 * Canonical CRUD adapter that the hardware-device CRUD UI
 * (`DeviceRegistryCard`) consumes. It reads through `useDeviceAssignments`
 * (canonical table) and writes directly to `device_assignments`.
 * (Wave 9b retired both the `useDeviceRegistry` shim and the legacy
 * `pos_hardware_configs` mirror table.)
 *
 * For module-level "give me the device bound to role X" lookups, use
 * `useDeviceForRole` instead. This hook is for the registry edit surface
 * only.
 */

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDeviceAssignments, type DeviceAssignment } from "@/hooks/useDeviceAssignments";
import { toast } from "sonner";
import type { DeviceRole, DriverType } from "@/services/hardware/drivers/DriverInterface";

/** Build a device_identifier from connection params for reconnection matching */
function buildDeviceIdentifier(connectionType: string, params: Record<string, unknown>): string | null {
  if (connectionType === "usb" && params.vendorId && params.productId) {
    return `usb:${(params.vendorId as number).toString(16).padStart(4, "0")}:${(params.productId as number).toString(16).padStart(4, "0")}`;
  }
  if (connectionType === "network" && params.ipAddress) {
    return `network:${params.ipAddress}:${params.port || 9100}`;
  }
  if (connectionType === "serial" && params.port) {
    return `serial:${params.port}`;
  }
  return null;
}

export interface DeviceConfig {
  id: string;
  organization_id: string;
  register_id: string | null;
  hardware_type: string;
  display_name: string;
  connection_type: string;
  connection_params: Record<string, unknown>;
  is_active: boolean;
  is_default: boolean;
  status: string;
  last_seen_at: string | null;
  driver_type: string | null;
  device_role: string | null;
  device_identifier: string | null;
  firmware_version: string | null;
  capabilities: string[] | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateDeviceInput {
  display_name: string;
  hardware_type: string;
  connection_type: string;
  connection_params: Record<string, unknown>;
  device_role: DeviceRole;
  driver_type: DriverType;
  register_id?: string | null;
  is_default?: boolean;
  device_identifier?: string;
}

export interface UpdateDeviceInput {
  id: string;
  display_name?: string;
  connection_type?: string;
  connection_params?: Record<string, unknown>;
  device_role?: DeviceRole;
  driver_type?: DriverType;
  is_active?: boolean;
  is_default?: boolean;
  status?: string;
  last_seen_at?: string;
  last_error?: string;
}

// ─────────────────────────────────────────────────────────────
// Translation: canonical DeviceAssignment → DeviceConfig (legacy UI shape)
// ─────────────────────────────────────────────────────────────

function toDeviceConfig(a: DeviceAssignment): DeviceConfig {
  const cfg = (a.config ?? {}) as Record<string, unknown>;
  const caps = a.capabilities as Record<string, unknown> | null;
  let capList: string[] | null = null;
  if (Array.isArray((caps as { list?: unknown })?.list)) {
    capList = (caps as { list: string[] }).list;
  } else if (caps && typeof caps === "object") {
    capList = Object.entries(caps)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    if (capList.length === 0) capList = null;
  }

  return {
    id: a.id,
    organization_id: a.organization_id,
    register_id: a.scope_kind === "register" ? a.scope_id : null,
    hardware_type: (cfg.hardware_type as string) ?? a.role,
    display_name: a.display_name,
    connection_type: a.transport,
    connection_params: cfg,
    is_active: a.enabled,
    is_default: a.is_default,
    status: a.status,
    last_seen_at: a.last_seen_at,
    driver_type: a.driver,
    device_role: a.role,
    device_identifier: (cfg.device_identifier as string) ?? null,
    firmware_version: (cfg.firmware_version as string) ?? null,
    capabilities: capList,
    last_error: a.last_error,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function useHardwareRegistryCrud(registerId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const scope = registerId
    ? ({ kind: "register", id: registerId } as const)
    : undefined;
  const { assignments, isLoading, error } = useDeviceAssignments(scope);

  const devices = useMemo<DeviceConfig[]>(() => {
    return assignments
      .filter((a) => !businessId || !a.business_id || a.business_id === businessId)
      .map(toDeviceConfig);
  }, [assignments, businessId]);

  const getDevicesByRole = (role: DeviceRole): DeviceConfig[] =>
    devices.filter((d) => d.device_role === role && d.is_active);

  const getDefaultDevice = (role: DeviceRole): DeviceConfig | null =>
    devices.find((d) => d.device_role === role && d.is_active && d.is_default) ??
    devices.find((d) => d.device_role === role && d.is_active) ??
    null;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["device-assignments"] });

  const createDevice = useMutation({
    mutationFn: async (input: CreateDeviceInput) => {
      if (!organizationId) throw new Error("No organization");
      if (!businessId) throw new Error("Select a Company before registering devices");

      const deviceIdentifier =
        input.device_identifier ??
        buildDeviceIdentifier(input.connection_type, input.connection_params) ??
        null;

      const cfgBlob: Record<string, unknown> = {
        ...(input.connection_params ?? {}),
        hardware_type: input.hardware_type,
        ...(deviceIdentifier ? { device_identifier: deviceIdentifier } : {}),
      };

      const payload = {
        organization_id: organizationId,
        business_id: businessId,
        scope_kind: input.register_id ? "register" : "tenant",
        scope_id: input.register_id ?? null,
        role: input.device_role,
        transport: input.connection_type,
        driver: input.driver_type,
        display_name: input.display_name,
        config: cfgBlob,
        capabilities: {},
        enabled: true,
        is_default: input.is_default ?? false,
        status: "unknown",
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: err } = await (supabase.from("device_assignments") as any)
        .insert(payload)
        .select()
        .single();
      if (err) throw err;
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Device registered successfully");
    },
    onError: (err) => {
      console.error("Failed to register device:", err);
      toast.error("Failed to register device");
    },
  });

  const updateDevice = useMutation({
    mutationFn: async (input: UpdateDeviceInput) => {
      const { id, connection_params, connection_type, device_role, driver_type,
              is_active, is_default, display_name, status, last_seen_at, last_error } = input;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (display_name !== undefined) patch.display_name = display_name;
      if (connection_type !== undefined) patch.transport = connection_type;
      if (device_role !== undefined) patch.role = device_role;
      if (driver_type !== undefined) patch.driver = driver_type;
      if (is_active !== undefined) patch.enabled = is_active;
      if (is_default !== undefined) patch.is_default = is_default;
      if (status !== undefined) patch.status = status;
      if (last_seen_at !== undefined) patch.last_seen_at = last_seen_at;
      if (last_error !== undefined) patch.last_error = last_error;
      if (connection_params !== undefined) patch.config = connection_params;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: err } = await (supabase.from("device_assignments") as any)
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (err) throw err;
      return data;
    },
    onSuccess: () => invalidate(),
    onError: (err) => {
      console.error("Failed to update device:", err);
      toast.error("Failed to update device");
    },
  });

  const deleteDevice = useMutation({
    mutationFn: async (deviceId: string) => {
      const { error: err } = await supabase
        .from("device_assignments")
        .delete()
        .eq("id", deviceId);
      if (err) throw err;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Device removed");
    },
    onError: (err) => {
      console.error("Failed to delete device:", err);
      toast.error("Failed to delete device");
    },
  });

  const updateDeviceStatus = useMutation({
    mutationFn: async (input: { id: string; status: string; lastError?: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch: Record<string, any> = {
        status: input.status,
        last_error: input.lastError ?? null,
        updated_at: new Date().toISOString(),
      };
      if (input.status === "online") patch.last_seen_at = new Date().toISOString();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: err } = await (supabase.from("device_assignments") as any)
        .update(patch)
        .eq("id", input.id);
      if (err) throw err;
    },
    onSuccess: () => invalidate(),
  });

  return {
    devices,
    isLoading,
    error,
    getDevicesByRole,
    getDefaultDevice,
    createDevice,
    updateDevice,
    deleteDevice,
    updateDeviceStatus,
  };
}
