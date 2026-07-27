/**
 * ElectronAssignmentHydrator — single-registry sync bridge.
 *
 * Pulls `device_assignments` rows for the current `(organization_id,
 * business_id)` from Supabase and pushes them into the Electron-local
 * SQLite cache via `window.pos.devices.upsert`. Subscribes to realtime
 * updates so the main-process DeviceManager always sees the latest binding.
 *
 * Scoping rules (Audit Wave 9d.5 — cross-business leak fix):
 *   - When a `businessId` is provided, ONLY rows matching that business are
 *     hydrated; tenant-default rows (`business_id IS NULL`) are also
 *     hydrated as fallbacks.
 *   - When a `terminalId` is provided, register-scoped rows for OTHER
 *     terminals are filtered out client-side; tenant/business defaults
 *     still flow through so the operator sees the global defaults.
 *
 * No-op in browser / SSR / preview environments.
 */
import { supabase } from '@/integrations/supabase/client';
import type { DeviceAssignment } from '@/hooks/useDeviceAssignments';
import { hostBridge } from './transport/HostRouter';

type DevicesIpc = {
  list: () => Promise<{ ok: boolean; rows?: unknown[]; error?: string }>;
  upsert: (input: {
    terminalId?: string | null;
    role: string;
    transport: string;
    driver: string;
    config: Record<string, unknown>;
    enabled?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: number) => Promise<{ ok: boolean; error?: string }>;
  setTerminal?: (terminalId: string | null) => Promise<{ ok: boolean; terminalId: string | null }>;
};

function getDevicesIpc(): DevicesIpc | null {
  // Phase 5 Step B — host access goes through HostRouter, never a local
  // `window.pos` cast (guard: host-state-single-owner).
  const pos = hostBridge<{ devices?: DevicesIpc }>();
  if (!pos?.devices?.list || !pos.devices.upsert) return null;
  return pos.devices;
}

function toElectronInput(row: DeviceAssignment) {
  const terminalId =
    row.scope_kind === 'register' || row.scope_kind === 'station'
      ? row.scope_id
      : null;
  return {
    terminalId,
    role: row.role,
    transport: row.transport,
    driver: row.driver,
    config: row.config ?? {},
    enabled: row.enabled,
  };
}

export interface HydratorScope {
  orgId: string;
  businessId?: string | null;
  terminalId?: string | null;
}

export interface HydratorStatus {
  active: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  rowsHydrated: number;
  scope: HydratorScope | null;
}

let started = false;
let unsubscribe: (() => void) | null = null;
const status: HydratorStatus = {
  active: false,
  lastSyncAt: null,
  lastError: null,
  rowsHydrated: 0,
  scope: null,
};

export function getHydratorStatus(): HydratorStatus {
  return { ...status, scope: status.scope ? { ...status.scope } : null };
}

async function hydrateOnce(scope: HydratorScope): Promise<void> {
  const ipc = getDevicesIpc();
  if (!ipc) return;

  let q = supabase
    .from('device_assignments')
    .select('*')
    .eq('organization_id', scope.orgId)
    .eq('enabled', true);

  // Business scoping: hydrate the active business AND tenant defaults
  // (business_id IS NULL). Defaults act as fallbacks when a business has
  // no explicit binding.
  if (scope.businessId) {
    q = q.or(`business_id.eq.${scope.businessId},business_id.is.null`);
  }

  const { data, error } = await q;
  if (error) {
    status.lastError = error.message;
    return;
  }

  const rows = (data ?? []) as unknown as DeviceAssignment[];

  // Terminal scoping: drop register/station rows that target a different
  // terminal. Tenant/business defaults pass through unchanged.
  const visible = scope.terminalId
    ? rows.filter((r) => {
        if (r.scope_kind === 'register' || r.scope_kind === 'station') {
          return r.scope_id === scope.terminalId;
        }
        return true;
      })
    : rows.filter((r) => r.scope_kind !== 'register' && r.scope_kind !== 'station');

  let pushed = 0;
  for (const r of visible) {
    try {
      const res = await ipc.upsert(toElectronInput(r));
      if (res.ok) pushed += 1;
    } catch (e) {
      status.lastError = (e as Error).message;
    }
  }
  status.rowsHydrated = pushed;
  status.lastSyncAt = Date.now();
  status.lastError = null;
}

/**
 * Start the hydrator. Idempotent — safe to call from multiple components.
 * Returns a stop function that detaches the realtime subscription.
 *
 * Backwards compat: a bare `orgId: string` is still accepted and behaves
 * like an org-only hydration (the historical pre-9d.5 behavior).
 */
export function startElectronAssignmentHydrator(
  scopeOrOrgId: HydratorScope | string,
): () => void {
  if (started) return () => {};
  if (!getDevicesIpc()) return () => {};

  const scope: HydratorScope =
    typeof scopeOrOrgId === 'string' ? { orgId: scopeOrOrgId } : scopeOrOrgId;

  started = true;
  status.active = true;
  status.scope = scope;

  // Push the active terminal to the Electron main process so its
  // AssignmentStore.loadActive(terminalId) returns the right rows.
  const ipc = getDevicesIpc();
  if (ipc?.setTerminal) {
    void ipc.setTerminal(scope.terminalId ?? null);
  }

  void hydrateOnce(scope);

  const filterParts = [`organization_id=eq.${scope.orgId}`];
  const channel = supabase
    .channel(`device_assignments_hydrator:${scope.orgId}:${scope.businessId ?? 'all'}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'device_assignments', filter: filterParts.join(',') },
      () => { void hydrateOnce(scope); },
    )
    .subscribe();

  unsubscribe = () => {
    void supabase.removeChannel(channel);
    started = false;
    status.active = false;
    status.scope = null;
  };
  return unsubscribe;
}

export function stopElectronAssignmentHydrator(): void {
  unsubscribe?.();
  unsubscribe = null;
}
