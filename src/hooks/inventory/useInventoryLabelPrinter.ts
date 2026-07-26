/**
 * useInventoryLabelPrinter — Wave 7 cross-module hardware seam.
 *
 * Inventory is the first non-POS consumer of the platform hardware
 * contract. Instead of hard-coding a printer lookup or reaching into the
 * POS hooks, the inventory app asks for the device bound to the
 * `label_printer` role for the current business scope (with tenant
 * default as fallback).
 *
 * This is the **canonical pattern** every module (Warehouse, HR,
 * Manufacturing) should copy when it needs hardware: pick a role via
 * `useDeviceForRole`, route the actual command through `hardwareClient`,
 * surface a "no device assigned" CTA when none is bound.
 *
 * Returns:
 *   - `device`        — the assignment for label_printer (null if none)
 *   - `hasDevice`     — boolean convenience
 *   - `missingDeviceCta` — { message, href } pointing users at
 *                          Platform → Hardware when no printer is bound
 *   - `printLabelBytes(bytes)` — fires raw bytes (typically ZPL or
 *                          ESC/POS produced server-side) at the bound
 *                          printer. No-op + structured error when
 *                          `hasDevice` is false.
 */
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDeviceForRole } from '@/hooks/useDeviceForRole';
import { useOrganization } from '@/hooks/useOrganization';
import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import type { DriverResult } from '@/services/hardware/drivers/DriverInterface';

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
  // Cross-module callers don't have a register/station context, but they
  // DO have an active business. `useDeviceForRole` pins on the current
  // `business_id` automatically (multi-branch tie-break), so two branches
  // each binding their own `label_printer` no longer collide.
  const { device, isLoading } = useDeviceForRole('label_printer');
  const { currentOrg } = useOrganization();
  const relayLabelPrinter = useQuery({
    queryKey: ['edge-relay-label-printer', currentOrg?.id ?? null],
    enabled: Boolean(currentOrg?.id),
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<boolean> => {
      if (!currentOrg?.id) return false;
      const { data, error } = await supabase
        .from('workstation_devices')
        .select('id')
        .eq('organization_id', currentOrg.id)
        .eq('role', 'label_printer')
        .in('health', ['ok', 'unknown'])
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
      // Audit Wave 9d.3 — was previously `hardwareClient.printRawBytes`
      // which routed to `receipt_printer:print_raw`. Labels now use the
      // dedicated `label_printer` role end-to-end (validator → handler →
      // driver → transport in Electron; adapter switch on the browser path).
      return hardwareClient.printLabelBytes(bytes);
    },
    [hasDevice],
  );

  return {
    device,
    hasDevice,
    isLoading: loadingAny,
    missingDeviceCta,
    printLabelBytes,
  };
}
