/**
 * useDeviceForRole — platform hardware-binding selector.
 *
 * Module-consumer entry point for hardware. Any non-POS module (Inventory
 * scanners, Warehouse label printers, HR biometric, Manufacturing scales)
 * MUST read hardware bindings through this hook. That keeps hardware a
 * platform concern, decoupled from any one app's lifecycle.
 *
 * Selection priority (highest first):
 *   1. Rows matching the explicit `scope` argument (e.g. register / station).
 *   2. Rows tagged with the active `businessId` (multi-branch tie-break).
 *   3. Rows flagged `is_default = true`.
 *   4. First enabled row.
 *
 * The business tie-break exists because a tenant with two branches each
 * binding a `receipt_printer` previously got non-deterministic
 * `pool[0]` selection — branch A could end up printing on branch B's
 * device. Passing the active business pins the choice.
 */
import { useMemo } from 'react';
import { useDeviceAssignments, type DeviceScope, type DeviceAssignment } from '@/hooks/useDeviceAssignments';
import { useBusinesses } from '@/hooks/useBusinesses';

export interface DeviceForRoleResult {
  device: DeviceAssignment | null;
  candidates: DeviceAssignment[];
  isLoading: boolean;
  error: Error | null;
}

export interface DeviceForRoleOptions {
  /** Explicit scope filter (register / station / user / tenant). */
  scope?: DeviceScope;
  /**
   * Override the active-business tie-break. When omitted, the currently
   * selected business from `BusinessContext` is used. Pass `null` to
   * disable the tie-break entirely (tests, platform-admin views).
   */
  preferBusinessId?: string | null;
}

export function useDeviceForRole(
  role: string,
  optsOrScope?: DeviceForRoleOptions | DeviceScope,
): DeviceForRoleResult {
  // Back-compat: callers used to pass a bare scope. Detect that shape and
  // promote into the options object.
  const opts: DeviceForRoleOptions = (
    optsOrScope && typeof optsOrScope === 'object' && 'kind' in (optsOrScope as Record<string, unknown>)
      ? { scope: optsOrScope as DeviceScope }
      : (optsOrScope as DeviceForRoleOptions | undefined) ?? {}
  );

  const { assignments, isLoading, error } = useDeviceAssignments(opts.scope);
  const { currentBusiness } = useBusinesses();
  const businessId =
    opts.preferBusinessId === undefined ? (currentBusiness?.id ?? null) : opts.preferBusinessId;

  const filtered = useMemo(
    () => assignments.filter((a) => a.role === role && a.enabled),
    [assignments, role],
  );

  const device = useMemo<DeviceAssignment | null>(() => {
    if (filtered.length === 0) return null;

    // Layer 1 — explicit scope rows beat tenant defaults.
    const explicitScope = opts.scope;
    const scoped = explicitScope && explicitScope.kind !== 'tenant'
      ? filtered.filter((a) => a.scope_kind === explicitScope.kind && a.scope_id === explicitScope.id)
      : [];
    let pool = scoped.length > 0 ? scoped : filtered;

    // Layer 2 — active-business tie-break. Only narrows when there is
    // actually a business-matching subset; otherwise fall through.
    if (businessId) {
      const branchHits = pool.filter((a) => a.business_id === businessId);
      if (branchHits.length > 0) pool = branchHits;
    }

    // Layer 3 — is_default flag.
    return pool.find((a) => a.is_default) ?? pool[0] ?? null;
  }, [filtered, opts.scope, businessId]);

  return { device, candidates: filtered, isLoading, error };
}
