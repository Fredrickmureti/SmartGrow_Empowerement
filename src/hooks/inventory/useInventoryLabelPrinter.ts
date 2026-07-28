/**
 * useInventoryLabelPrinter — Phase 2b (unified device registry).
 *
 * Inventory is the canonical non-POS consumer of the hardware contract.
 * It resolves the device bound to the `label_printer` role for the
 * current business scope (with tenant default as fallback). The
 * additional "any workstation-attached label printer" fallback previously
 * lived on a separate mirror table; that mirror has been retired (Phase 6
 * Step C) and a single query against `device_assignments` now covers
 * both business-scoped and workstation-scoped rows.
 *
 * This hook reports *presence* only. Dispatch belongs to PrintService —
 * a hook that both resolved a device and talked to the agent would be a
 * second printing pipeline.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDeviceForRole } from '@/hooks/useDeviceForRole';
import { useOrganization } from '@/hooks/useOrganization';
import { supabase } from '@/integrations/supabase/client';

export interface MissingLabelPrinterCta {
  message: string;
  href: string;
}

export interface InventoryLabelPrinterApi {
  device: ReturnType<typeof useDeviceForRole>['device'];
  hasDevice: boolean;
  isLoading: boolean;
  missingDeviceCta: MissingLabelPrinterCta | null;
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

  return {
    device,
    hasDevice,
    isLoading: loadingAny,
    missingDeviceCta,
  };
}
