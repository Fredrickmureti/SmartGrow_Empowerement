/**
 * useInventoryLabelPrinter — Phase 2b (unified device registry).
 *
 * Inventory is the canonical non-POS consumer of the hardware contract.
 * It resolves the device bound to the `label_printer` role for the
 * current business scope (with tenant default as fallback). The
 * additional "any workstation-attached label printer" fallback used the
 * legacy `workstation_devices` table; Phase 2a merged those rows into
 * `device_assignments`, so a single role query now covers both cases.
 */
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDeviceForRole } from '@/hooks/useDeviceForRole';
import { useOrganization } from '@/hooks/useOrganization';
import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import type { DriverResult } from '@/services/hardware/drivers/DriverInterface';
import type { DeviceRole } from '@/services/hardware/drivers/DriverInterface';

export interface MissingLabelPrinterCta {
  message: string;
  href: string;
}

export interface InventoryLabelPrinterApi {
  device: ReturnType<typeof useDeviceForRole>['device'];
  hasDevice: boolean;
  isLoading: boolean;
  missingDeviceCta: MissingLabelPrinterCta | null;
  printLabelBytes: (bytes: Uint8Array | number[]) => Promise<DriverResult>;
}

const PLATFORM_HARDWARE_HREF = '/platform/hardware/devices';

export function useInventoryLabelPrinter(): InventoryLabelPrinterApi {
  const { device, isLoading } = useDeviceForRole('label_printer');
  const { currentOrg } = useOrganization();

  // Fallback: any workstation-attached label printer for the org. Under
  // the unified registry these are rows in `device_assignments` with a
  // `workstation_id` set.
  const relayLabelPrinter = useQuery({
    queryKey: ['edge-relay-label-printer', currentOrg?.id ?? null],
    enabled: Boolean(currentOrg?.id),
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<boolean> => {
      if (!currentOrg?.id) return false;
      const { data, error } = await supabase
        .from('device_assignments')
        .select('id')
        .eq('organization_id', currentOrg.id)
        .eq('role', 'label_printer')
        .eq('enabled', true)
        .not('workstation_id', 'is', null)
        .in('status', ['ok', 'unknown'])
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  });

  const hasDevice = Boolean(device) || Boolean(relayLabelPrinter.data);
  const loadingAny = isLoading || relayLabelPrinter.isLoading;

  const missingDeviceCta = useMemo<MissingLabelPrinterCta | null>(() => {
    if (loadingAny || hasDevice) return null;
    return {
      message:
        'No label printer is assigned to this workspace. Bind one in Platform → Hardware to enable label printing.',
      href: PLATFORM_HARDWARE_HREF,
    };
  }, [loadingAny, hasDevice]);

  const printLabelBytes = useCallback(
    async (bytes: Uint8Array | number[]): Promise<DriverResult> => {
      if (!hasDevice) {
        return {
          success: false,
          error:
            'No label printer assigned. Open Platform → Hardware to bind one.',
        };
      }
      // Phase 5 Step B — per-assignment dispatch. When the platform
      // resolver picked a concrete `device_assignments` row, route via
      // `execAssignment` so `TransportRouter` sees the row's persisted
      // `transport` (electron | local_agent | webusb | webhid) instead
      // of a role-only fan-out at the driver seam.
      if (device) {
        return hardwareClient.execAssignment({
          assignment: {
            id: device.id,
            role: device.role as DeviceRole,
            transport: device.transport,
            enabled: device.enabled,
          },
          op: 'print_raw',
          payload: Array.from(bytes),
        });
      }
      // Fallback — only the workstation-relay probe found a device (no
      // resolver row surfaced through `useDeviceForRole`). Legacy path.
      return hardwareClient.printLabelBytes(bytes);
    },
    [hasDevice, device],
  );

  return {
    device,
    hasDevice,
    isLoading: loadingAny,
    missingDeviceCta,
    printLabelBytes,
  };
}
