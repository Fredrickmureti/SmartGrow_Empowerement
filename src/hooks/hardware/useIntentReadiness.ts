/**
 * useIntentReadiness — React façade over `resolveIntentReadiness`.
 *
 * The single source of truth for print-readiness gates in the UI. Do NOT
 * derive availability from `hardwareClient.devices.getStatuses()` — that is
 * a local runtime probe and reports `false` for perfectly reachable
 * relay-routed printers (see `services/hardware/readiness.ts`).
 */
import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/hooks/useOrganization';
import { useBusinesses } from '@/hooks/useBusinesses';
import {
  resolveIntentReadiness,
  type IntentReadiness,
} from '@/services/hardware/readiness';
import type { PrintIntent } from '@/services/printing/types';
import type { DeviceScope } from '@/hooks/useDeviceAssignments';

export interface UseIntentReadinessOptions {
  scope?: DeviceScope;
  /** Poll interval in ms. Default 15s — matches the agent heartbeat cadence. */
  refetchInterval?: number;
  enabled?: boolean;
}

export function useIntentReadiness(
  intentOrRole: PrintIntent | string,
  options: UseIntentReadinessOptions = {},
) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const scopeKind = options.scope?.kind ?? null;
  const scopeId =
    options.scope && options.scope.kind !== 'tenant' ? options.scope.id : null;

  const query = useQuery({
    queryKey: ['intent-readiness', orgId, businessId, intentOrRole, scopeKind, scopeId],
    enabled: options.enabled ?? true,
    staleTime: 10_000,
    refetchInterval: options.refetchInterval ?? 15_000,
    queryFn: (): Promise<IntentReadiness> =>
      resolveIntentReadiness({
        organizationId: orgId,
        intentOrRole,
        businessId,
        scope: options.scope,
      }),
  });

  return {
    readiness: query.data ?? null,
    state: query.data?.state ?? 'unknown',
    isReady: query.data?.ready ?? false,
    message: query.data?.message ?? 'Checking printer…',
    detail: query.data?.detail,
    isChecking: query.isLoading || query.isFetching,
    refresh: query.refetch,
  };
}
