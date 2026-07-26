import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/hooks/useOrganization';
import { useBusinesses } from '@/contexts/BusinessContext';
import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import type { DeviceAssignment } from '@/services/hardware/BrowserHardwareAdapter';
import type { DeviceRole, DriverType } from '@/services/hardware/drivers/DriverInterface';

interface WorkstationRow {
  id: string;
  organization_id: string;
  name: string;
  version: string | null;
  last_seen_at: string | null;
}

interface WorkstationDeviceRow {
  id: string;
  workstation_id: string;
  device_key: string;
  role: string;
  transport: string;
  driver: string | null;
  name: string | null;
  capabilities: Record<string, unknown> | null;
  health: string;
  metadata: Record<string, unknown> | null;
  last_seen_at: string | null;
}

const DEVICE_ROLES = new Set<DeviceRole>([
  'receipt_printer',
  'kitchen_printer',
  'cash_drawer',
  'barcode_scanner',
  'customer_display',
  'scale',
  'payment_terminal',
  'label_printer',
  'a4_printer',
  'scanner',
  'clock_terminal',
  'biometric_reader',
  'saga',
]);

const DRIVER_TYPES = new Set<DriverType>([
  'escpos',
  'star',
  'citizen',
  'bixolon',
  'epson',
  'epos_printer',
  'generic_scale',
  'toledo_scale',
  'cas_scale',
  'mettler_scale',
  'keyboard_scanner',
  'hid_scanner',
  'escpos_drawer',
  'secondary_screen_display',
  'line_display',
  'worldline_terminal',
  'adyen_terminal',
  'generic_terminal',
  'browser_print',
]);

/**
 * Production web relay mount.
 *
 * On https://accrualflow.systems the browser cannot call the local agent's
 * plaintext loopback listener. This mount selects the freshest enrolled Edge
 * workstation, enables Supabase relay dispatch, and loads the published
 * `workstation_devices` into the renderer adapter so existing label/receipt
 * flows keep using `hardwareClient` unchanged.
 */
export function EdgeRelayMount() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;

  const workstations = useQuery({
    queryKey: ['edge-workstations', orgId],
    enabled: Boolean(orgId) && !hardwareClient.devices.isElectron(),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<WorkstationRow[]> => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from('workstations')
        .select('id,organization_id,name,version,last_seen_at')
        .eq('organization_id', orgId)
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as WorkstationRow[];
    },
  });

  const workstation = useMemo(
    () => (workstations.data ?? []).find((row) => Boolean(row.last_seen_at)) ?? workstations.data?.[0] ?? null,
    [workstations.data],
  );

  const devices = useQuery({
    queryKey: ['edge-workstation-devices', orgId, workstation?.id ?? null],
    enabled: Boolean(orgId && workstation?.id) && !hardwareClient.devices.isElectron(),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<WorkstationDeviceRow[]> => {
      if (!orgId || !workstation?.id) return [];
      const { data, error } = await supabase
        .from('workstation_devices')
        .select('id,workstation_id,device_key,role,transport,driver,name,capabilities,health,metadata,last_seen_at')
        .eq('organization_id', orgId)
        .eq('workstation_id', workstation.id)
        .in('health', ['ok', 'unknown'])
        .order('role', { ascending: true })
        .order('last_seen_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as WorkstationDeviceRow[];
    },
  });

  useEffect(() => {
    if (!orgId || !workstation?.id || hardwareClient.devices.isElectron()) {
      hardwareClient.agent.disableRelay();
      hardwareClient.devices.loadAssignments([]);
      return;
    }

    hardwareClient.agent.enableRelay({
      organizationId: orgId,
      workstationId: workstation.id,
      defaultDeadlineMs: 45_000,
    });

    const assignments = (devices.data ?? [])
      .map((device) => toAssignment(device, businessId))
      .filter((device): device is DeviceAssignment => Boolean(device));

    hardwareClient.devices.loadAssignments(assignments);
    if (assignments.length > 0) {
      void hardwareClient.devices.connectAll();
    }
  }, [businessId, devices.data, orgId, workstation?.id]);

  return null;
}

function toAssignment(row: WorkstationDeviceRow, businessId: string | null): DeviceAssignment | null {
  const role = normalizeRole(row.role);
  if (!role) return null;

  const connectionParams = buildConnectionParams(row);
  if (!connectionParams) return null;

  return {
    id: `edge:${row.id}`,
    deviceRole: role,
    driverType: normalizeDriver(row.driver, role),
    connectionParams: {
      ...connectionParams,
      business_id: businessId,
      edge_device_key: row.device_key,
      edge_workstation_id: row.workstation_id,
    },
    displayName: row.name ?? row.device_key,
    isActive: row.health !== 'offline' && row.health !== 'error',
  };
}

function normalizeRole(role: string): DeviceRole | null {
  if (role === 'drawer') return 'cash_drawer';
  if (role === 'display') return 'customer_display';
  if (role === 'eft_terminal') return 'payment_terminal';
  if (role === 'biometric') return 'biometric_reader';
  return DEVICE_ROLES.has(role as DeviceRole) ? role as DeviceRole : null;
}

function normalizeDriver(driver: string | null, role: DeviceRole): DriverType {
  // The browser fallback only needs a raw-byte pass-through for ZPL/EPL labels;
  // EscPosPrinterDriver supplies that transport without transforming bytes.
  if (driver === 'zpl' || driver === 'epl') return 'escpos';
  if (driver && DRIVER_TYPES.has(driver as DriverType)) return driver as DriverType;
  if (role === 'cash_drawer') return 'escpos_drawer';
  if (role === 'scale') return 'generic_scale';
  if (role === 'customer_display') return 'secondary_screen_display';
  if (role === 'barcode_scanner' || role === 'scanner') return 'keyboard_scanner';
  return 'escpos';
}

function buildConnectionParams(row: WorkstationDeviceRow): Record<string, unknown> | null {
  const meta = row.metadata ?? {};
  const parsedTcp = parseTcpKey(row.device_key);
  if (row.transport === 'tcp' || row.transport === 'network') {
    const ipAddress = stringValue(meta.ipAddress) ?? stringValue(meta.host) ?? parsedTcp?.ipAddress;
    const port = numberValue(meta.port) ?? parsedTcp?.port ?? 9100;
    if (!ipAddress) return null;
    return { connection_type: 'network', ipAddress, port };
  }
  if (row.transport === 'usb') {
    const vendorId = numberValue(meta.vendor_id) ?? numberValue(meta.vendorId);
    const productId = numberValue(meta.product_id) ?? numberValue(meta.productId);
    if (vendorId == null || productId == null) return null;
    return { connection_type: 'usb', vendorId, productId };
  }
  return null;
}

function parseTcpKey(key: string): { ipAddress: string; port: number } | null {
  const match = /^tcp:(.+):(\d+)$/.exec(key);
  if (!match) return null;
  return { ipAddress: match[1], port: Number(match[2]) };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}