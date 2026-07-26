/**
 * useDeviceForIntent — Phase 3 client façade over the `resolve_device` RPC.
 *
 * One hook, one server round-trip, one tie-break contract. Callers pass a
 * `PrintIntent` (or a raw role). The hook maps intent → hardware role, then
 * asks Postgres to pick the winning `device_assignments` row using the exact
 * same layered rule the client-side `useDeviceForRole` implements:
 *
 *   1. Explicit scope match (register / station / user)   [server]
 *   2. Active-business tie-break                          [server]
 *   3. `is_default = true`                                [server]
 *   4. Most-recently-seen, else earliest created          [server]
 *
 * Keeping the tie-break server-side means edge functions, background jobs,
 * and the UI all agree on which physical device a given intent lands on —
 * no more "browser tab printed on branch B while the receipt policy pointed
 * at branch A" drift.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/hooks/useOrganization';
import { useBusinesses } from '@/hooks/useBusinesses';
import type { PrintIntent } from '@/services/printing/PrintClient';
import type { DeviceAssignment, DeviceScope } from '@/hooks/useDeviceAssignments';

/**
 * Canonical intent → hardware role map. Kept in one place so PrintClient,
 * useDeviceForIntent, and the eventual server-side `resolve_device` caller
 * inside `generate-document` all agree on the mapping.
 */
export const INTENT_TO_ROLE: Record<PrintIntent, string> = {
  receipt: 'receipt_printer',
  kitchen_ticket: 'kitchen_printer',
  label: 'label_printer',
  a4_document: 'a4_printer',
  packing_slip: 'a4_printer',
};

export interface DeviceForIntentOptions {
  scope?: DeviceScope;
  /** Override the active-business tie-break. `null` disables it. */
  preferBusinessId?: string | null;
  enabled?: boolean;
}

export interface DeviceForIntentResult {
  device: DeviceAssignment | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Resolve the device that will service a given print intent (or bare role).
 * Server-authoritative — mirrors `useDeviceForRole` semantics via the
 * `resolve_device` RPC so UI and edge functions never disagree.
 */
export function useDeviceForIntent(
  intentOrRole: PrintIntent | string,
  opts: DeviceForIntentOptions = {},
): DeviceForIntentResult {
  const { organization } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const role =
    (INTENT_TO_ROLE as Record<string, string>)[intentOrRole] ?? intentOrRole;

  const businessId =
    opts.preferBusinessId === undefined
      ? (currentBusiness?.id ?? null)
      : opts.preferBusinessId;

  const scopeKind = opts.scope?.kind ?? null;
  const scopeId =
    opts.scope && opts.scope.kind !== 'tenant' ? opts.scope.id : null;

  const query = useQuery({
    queryKey: [
      'resolve_device',
      organization?.id ?? null,
      role,
      businessId,
      scopeKind,
      scopeId,
    ],
    enabled: Boolean(organization?.id) && (opts.enabled ?? true),
    queryFn: async (): Promise<DeviceAssignment | null> => {
      const { data, error } = await supabase.rpc('resolve_device', {
        _organization_id: organization!.id,
        _role: role,
        _business_id: businessId,
        _scope_kind: scopeKind,
        _scope_id: scopeId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row as DeviceAssignment | undefined) ?? null;
    },
    staleTime: 15_000,
  });

  return {
    device: query.data ?? null,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}

/**
 * Imperative twin of `useDeviceForIntent` for non-React call sites (event-loop
 * callbacks, dispatch hot lanes, edge-adjacent code). Same server-authoritative
 * tie-break — literally the same RPC — so a `printReceipt()` inside a
 * `useCallback` and a `useDeviceForIntent(...)` inside a component land on
 * identical `DeviceAssignment` rows for the same (org, role, scope) inputs.
 *
 * Returns `null` if no assignment matches. Callers dispatch to the returned
 * `id` (or refuse with a missing-device toast) — never to a role-only lookup.
 */
export interface ResolveDeviceForIntentInput {
  organizationId: string;
  intentOrRole: PrintIntent | string;
  businessId?: string | null;
  scope?: DeviceScope;
}

export async function resolveDeviceForIntent(
  input: ResolveDeviceForIntentInput,
): Promise<DeviceAssignment | null> {
  const role =
    (INTENT_TO_ROLE as Record<string, string>)[input.intentOrRole] ??
    input.intentOrRole;
  const scopeKind = input.scope?.kind ?? null;
  const scopeId =
    input.scope && input.scope.kind !== 'tenant' ? input.scope.id : null;
  const { data, error } = await supabase.rpc('resolve_device', {
    _organization_id: input.organizationId,
    _role: role,
    _business_id: input.businessId ?? null,
    _scope_kind: scopeKind,
    _scope_id: scopeId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as DeviceAssignment | undefined) ?? null;
}
