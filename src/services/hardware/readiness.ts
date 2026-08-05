/**
 * readiness.ts — the ONE answer to "can this intent actually print right now?".
 *
 * ## Why this exists
 *
 * The platform can execute hardware in three places:
 *
 *   1. Electron main process (DeviceManager owns the transports)
 *   2. A local IoT agent on loopback
 *   3. A *remote* IoT agent, reached through the Supabase `edge_jobs` relay
 *
 * Path (3) is why a phone can print an invoice on the till's printer. But
 * readiness used to be answered by `hardwareClient.devices.getStatuses()`,
 * which reports the *renderer adapter's local connection state*. A printer
 * owned by another machine's agent is never "connected" locally, so POS
 * showed "No printer connected" while Invoice/Label printing — which never
 * consults that probe — worked fine.
 *
 * Readiness is a **registry + heartbeat** question, not a local transport
 * question:
 *
 *   - Is a `device_assignments` row bound for this intent? (`resolve_device`)
 *   - Is the workstation that owns it alive? (`workstations.last_seen_at`)
 *   - Or can the local runtime serve it directly? (Electron / loopback agent)
 *
 * Every UI readiness gate must come through here. `getStatuses()` remains a
 * *runtime diagnostics* probe and must not be used to decide availability.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import { resolveDeviceForIntent, INTENT_TO_ROLE } from '@/hooks/useDeviceForIntent';
import type { PrintIntent } from '@/services/printing/types';
import type { DeviceScope } from '@/hooks/useDeviceAssignments';

/**
 * The agent polls every 1.5 s and stamps `workstations.last_seen_at`. Kept
 * in sync with `RelayTransport`'s own fail-fast window — if the relay would
 * refuse to queue, readiness must not claim "ready".
 */
export const WORKSTATION_LIVENESS_WINDOW_MS = 20_000;

export type IntentReadinessState =
  /** A device is bound and its executor is reachable. */
  | 'ready'
  /** No `device_assignments` row answers this intent. */
  | 'no_device_bound'
  /** A device is bound, but the workstation that owns it stopped polling. */
  | 'workstation_offline'
  /** Bound and reachable, but the device itself reported an error state. */
  | 'degraded'
  /** Device is local-only (no workstation) and this runtime cannot reach it. */
  | 'local_only_unavailable'
  /**
   * A device is bound and its transport needs an executor (agent /
   * workstation), but no workstation owns the row — nothing can carry the
   * bytes, so dispatch would fail even though the registry looks healthy.
   */
  | 'unroutable'
  /** Readiness could not be determined (no org context, resolver failed). */
  | 'unknown';

export interface IntentReadiness {
  state: IntentReadinessState;
  /** Convenience: `state === 'ready' || state === 'degraded'`. */
  ready: boolean;
  /** Hardware role the intent resolved to. */
  role: string;
  device: {
    id: string;
    displayName: string;
    workstationId: string | null;
  } | null;
  /** Operator-facing one-liner. Never a raw error string. */
  message: string;
  /** Optional secondary detail (e.g. "last polled 3m ago"). */
  detail?: string;
  checkedAt: Date;
}

export interface ResolveIntentReadinessInput {
  organizationId: string | null | undefined;
  intentOrRole: PrintIntent | string;
  businessId?: string | null;
  scope?: DeviceScope;
}

function isElectronRuntime(): boolean {
  try {
    return hardwareClient.devices.isElectron();
  } catch {
    return false;
  }
}

/** True when a print agent on THIS machine is up and authorized. It can carry
 *  bytes to a LAN printer regardless of any `workstation_id` bookkeeping. */
function localAgentAvailable(): boolean {
  try {
    return hardwareClient.agent.isAvailable() && hardwareClient.agent.isAuthorized();
  } catch {
    return false;
  }
}


function ageLabel(iso: string | null): string | undefined {
  if (!iso) return 'never polled';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 90) return `last polled ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `last polled ${mins}m ago`;
  return `last polled ${Math.round(mins / 60)}h ago`;
}

/** Local runtime liveness for a role — Electron or a loopback agent only. */
async function localRoleConnected(role: string): Promise<boolean> {
  try {
    const statuses = await hardwareClient.devices.getStatuses();
    return statuses.some((s) => s.role === role && s.connected);
  } catch {
    return false;
  }
}

function result(partial: Omit<IntentReadiness, 'ready' | 'checkedAt'>): IntentReadiness {
  return {
    ...partial,
    ready: partial.state === 'ready' || partial.state === 'degraded',
    checkedAt: new Date(),
  };
}

/**
 * Resolve readiness for a print intent (or bare hardware role).
 *
 * Never throws: a resolver/network failure degrades to `unknown` with an
 * honest operator message rather than a false "no printer".
 */
export async function resolveIntentReadiness(
  input: ResolveIntentReadinessInput,
): Promise<IntentReadiness> {
  const role =
    (INTENT_TO_ROLE as Record<string, string>)[input.intentOrRole] ??
    String(input.intentOrRole);

  if (!input.organizationId) {
    // No tenant context yet (bootstrapping). Fall back to the local runtime
    // so Electron/loopback setups still report honestly.
    const connected = await localRoleConnected(role);
    return result({
      state: connected ? 'ready' : 'unknown',
      role,
      device: null,
      message: connected ? 'Printer ready' : 'Checking printer…',
    });
  }

  let device: Awaited<ReturnType<typeof resolveDeviceForIntent>> = null;
  try {
    device = await resolveDeviceForIntent({
      organizationId: input.organizationId,
      intentOrRole: role,
      businessId: input.businessId ?? null,
      scope: input.scope,
    });
  } catch {
    return result({
      state: 'unknown',
      role,
      device: null,
      message: 'Could not check printer availability',
    });
  }

  if (!device) {
    return result({
      state: 'no_device_bound',
      role,
      device: null,
      message: 'No printer assigned for this device role',
      detail: 'Bind one in Hardware settings to print directly.',
    });
  }

  // `resolve_device` returns the registry row; `workstation_id` is present on
  // the table but not on the shared client type, so read it defensively.
  const workstationId =
    (device as unknown as { workstation_id?: string | null }).workstation_id ?? null;

  const identity = {
    id: device.id,
    displayName: device.display_name,
    workstationId,
  };

  if (!workstationId) {
    // No owning workstation. Electron and WebUSB can still serve the device
    // from this machine; a network/agent transport cannot — those bytes need
    // an agent to carry them.
    const transport = String(
      (device as unknown as { transport?: string | null }).transport ?? '',
    ).toLowerCase();
    const needsWorkstation =
      transport === 'network' || transport === 'local_agent' ||
      transport === 'serial' || transport === 'usb' || transport === 'tcp';

    if (needsWorkstation && !isElectronRuntime()) {
      // A live agent on THIS machine is a legitimate executor for a LAN
      // printer even with no `workstation_id` on the row: it reaches the
      // printer over the network itself. Without this, POS reported
      // "Printer offline" for a printer it was successfully printing to,
      // because a workstation row is an inventory record, not a transport.
      if (localAgentAvailable()) {
        return result({
          state: device.status === 'error' ? 'degraded' : 'ready',
          role,
          device: identity,
          message:
            device.status === 'error'
              ? `${device.display_name} reported a problem — printing may fail`
              : `${device.display_name} ready`,
          detail: 'Served by the print agent on this computer.',
        });
      }
      const connected = await localRoleConnected(role);
      if (!connected) {
        return result({
          state: 'unroutable',
          role,
          device: identity,
          message: `${device.display_name} is not assigned to a computer, so nothing can send it print jobs`,
          detail: 'Pick the workstation that this printer is connected to in Hardware settings.',
        });
      }
    }

    const connected = isElectronRuntime() || (await localRoleConnected(role));
    return result({
      state: connected ? 'ready' : 'local_only_unavailable',
      role,
      device: identity,
      message: connected
        ? `${device.display_name} ready`
        : `${device.display_name} is only reachable from the machine it is plugged into`,
    });
  }


  let lastSeenAt: string | null = null;
  try {
    const { data, error } = await supabase
      .from('workstations')
      .select('last_seen_at')
      .eq('id', workstationId)
      .maybeSingle();
    if (error) throw error;
    lastSeenAt = (data as { last_seen_at: string | null } | null)?.last_seen_at ?? null;
  } catch {
    return result({
      state: 'unknown',
      role,
      device: identity,
      message: 'Could not check printer availability',
    });
  }

  const alive =
    Boolean(lastSeenAt) &&
    Date.now() - new Date(lastSeenAt as string).getTime() <= WORKSTATION_LIVENESS_WINDOW_MS;

  if (!alive) {
    return result({
      state: 'workstation_offline',
      role,
      device: identity,
      message: `${device.display_name} is offline — the computer running the print agent is not responding`,
      detail: ageLabel(lastSeenAt),
    });
  }

  if (device.status === 'error') {
    return result({
      state: 'degraded',
      role,
      device: identity,
      message: `${device.display_name} reported a problem — printing may fail`,
      detail: device.last_error ?? undefined,
    });
  }

  return result({
    state: 'ready',
    role,
    device: identity,
    message: `${device.display_name} ready`,
  });
}
