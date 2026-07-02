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
import { useDeviceForRole } from '@/hooks/useDeviceForRole';
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
  const hasDevice = Boolean(device);

  const missingDeviceCta = useMemo<MissingLabelPrinterCta | null>(() => {
    if (isLoading || hasDevice) return null;
    return {
      message:
        'No label printer is assigned to this workspace. Bind one in Platform → Hardware to enable label printing.',
      href: PLATFORM_HARDWARE_HREF,
    };
  }, [isLoading, hasDevice]);

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
    isLoading,
    missingDeviceCta,
    printLabelBytes,
  };
}
