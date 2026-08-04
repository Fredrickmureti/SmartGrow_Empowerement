import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/hooks/useOrganization';
import { useBusinesses } from '@/contexts/BusinessContext';
import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import type { DeviceAssignment } from '@/services/hardware/BrowserHardwareAdapter';
import type { DeviceRole, DriverType } from '@/services/hardware/drivers/DriverInterface';
import { WORKSTATION_LIVENESS_WINDOW_MS } from '@/services/hardware/readiness';

interface WorkstationRow {
  id: string;
  organization_id: string;
  branch_id: string | null;
  name: string;
  version: string | null;
  last_seen_at: string | null;
}

// Reads from the canonical `device_assignments` registry (rows scoped
// to a workstation by `workstation_id`). The legacy
// `workstation_devices` mirror table was retired in Phase 6 Step C.
interface EdgeDeviceRow {
  id: string;
  workstation_id: string;
  device_key: string | null;
  role: string;
  transport: string;
  driver: string | null;
  display_name: string;
  capabilities: Record<string, unknown> | null;
  status: string;
  config: Record<string, unknown> | null;
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
 * `device_assignments` rows (scoped to that workstation) into the renderer
 * adapter so existing label/receipt flows keep using `hardwareClient`
 * unchanged.
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
        .select('id,organization_id,branch_id,name,version,last_seen_at')
        .eq('organization_id', orgId)
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as WorkstationRow[];
    },
  });

  /**
   * Pick the workstation this browser should route through.
   *
   * Previously this took the freshest row org-wide with no liveness window,
   * so a stale or unrelated workstation could capture routing for everyone.
   * Now: only workstations that are actually polling (inside
   * `WORKSTATION_LIVENESS_WINDOW_MS`) are eligible, and a same-branch
   * workstation always wins over an out-of-branch one.
   */
  const workstation = useMemo(() => {
    const rows = workstations.data ?? [];
    const live = rows.filter(
      (row) =>
        row.last_seen_at &&
        Date.now() - new Date(row.last_seen_at).getTime() <= WORKSTATION_LIVENESS_WINDOW_MS,
    );
    if (live.length === 0) return null;
    return (
      live.find((row) => branchId && row.branch_id === branchId) ?? live[0]
    );
  }, [workstations.data, branchId]);

  const devices = useQuery({
    queryKey: ['edge-workstation-devices', orgId, workstation?.id ?? null],
    enabled: Boolean(orgId && workstation?.id) && !hardwareClient.devices.isElectron(),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<EdgeDeviceRow[]> => {
      if (!orgId || !workstation?.id) return [];
      const { data, error } = await supabase
        .from('device_assignments')
        .select('id,workstation_id,device_key,role,transport,driver,display_name,capabilities,status,config,last_seen_at')
        .eq('organization_id', orgId)
        .eq('workstation_id', workstation.id)
        .eq('enabled', true)
        .in('status', ['ok', 'unknown'])
        .order('role', { ascending: true })
        .order('last_seen_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as EdgeDeviceRow[];
    },
  });

  // This component is the SINGLE owner of the renderer adapter registry:
  // the only caller of `loadAssignments` and `connectAll` in the app. Two
  // writers previously raced here (see `useHardwareProxy`), so whichever
  // mounted last wiped the other's device list.
  useEffect(() => {
    if (hardwareClient.devices.isElectron()) return;

    // Never tear down relay/assignments while a query is merely in flight —
    // that used to blank the device list on every refetch tick.
    if (workstations.isLoading || (workstation?.id && devices.isLoading)) return;

    if (!orgId || !workstation?.id) {
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
  }, [businessId, devices.data, devices.isLoading, orgId, workstation?.id, workstations.isLoading]);

  return null;
}

function toAssignment(row: EdgeDeviceRow, businessId: string | null): DeviceAssignment | null {
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
      edge_device_key: row.device_key ?? row.id,
      edge_workstation_id: row.workstation_id,
    },
    displayName: row.display_name ?? row.device_key ?? row.id,
    isActive: row.status !== 'offline' && row.status !== 'error',
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
  if (driver === 'zpl' || driver === 'epl') return 'escpos';
  if (driver && DRIVER_TYPES.has(driver as DriverType)) return driver as DriverType;
  if (role === 'cash_drawer') return 'escpos_drawer';
  if (role === 'scale') return 'generic_scale';
  if (role === 'customer_display') return 'secondary_screen_display';
  if (role === 'barcode_scanner' || role === 'scanner') return 'keyboard_scanner';
  return 'escpos';
}

function buildConnectionParams(row: EdgeDeviceRow): Record<string, unknown> | null {
  const meta = row.config ?? {};
  const parsedTcp = parseTcpKey(row.device_key ?? '');
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
