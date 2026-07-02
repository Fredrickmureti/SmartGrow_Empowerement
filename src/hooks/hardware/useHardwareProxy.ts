/**
 * useHardwareProxy — platform hook for hardware operations.
 *
 * (Wave 9c) Relocated from `src/hooks/pos/` to `src/hooks/hardware/` to
 * reflect that hardware is a platform concern, not a POS module concern.
 * The hook still happens to be used most heavily by POS, but any module
 * (Inventory, Warehouse, HR) may consume it; nothing here is POS-specific.
 *
 * Track H4 (ADR-0014). Every hardware call routes through `hardwareClient`;
 * the renderer-side `browserHardwareAdapter` and the legacy `iotBoxClient`
 * are no longer reachable from this hook. The `no-legacy-hardware-shell`
 * guard test enforces that boundary repo-wide.
 *
 * Responsibilities:
 *   1. Load device configs from the canonical `device_assignments` table
 *      and hand them to `hardwareClient.devices.loadAssignments(...)` so the
 *      browser-mode runtime knows what's wired (no-op in Electron — the main
 *      process owns its own registry).
 *   2. Auto-connect on session start (browser only — DeviceManager does this
 *      automatically in Electron).
 *   3. Expose abstract action methods (printReceipt, openDrawer, etc.) that
 *      forward to `hardwareClient.*` so callers stay platform-blind.
 *   4. Surface honest per-role status from `hardwareClient.devices.getStatuses()`
 *      and refresh on push events from the hardware event bus.
 */

import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import type { DeviceAssignment } from '@/services/hardware';
import { hardwareClient, type DeviceStatusDetail } from '@/services/hardware/HardwareClient';
import {
  useDeviceAssignments,
  type DeviceAssignment as CanonicalAssignment,
} from '@/hooks/useDeviceAssignments';
import type { DeviceRole, DriverResult } from '@/services/hardware/drivers/DriverInterface';
import type { ReceiptData } from '@/services/hardware/types/receipt';

export interface ProxyDeviceStatus {
  role: DeviceRole;
  displayName: string;
  connected: boolean;
  status: string;
  lastError?: string;
  state: DeviceStatusDetail['state'];
  latencyMs?: number;
  lastPingAt?: number;
  consecutiveFailures?: number;
}

export interface HardwareProxyState {
  isLoaded: boolean;
  isConnecting: boolean;
  deviceStatuses: Map<string, ProxyDeviceStatus>;
  lastError: string | null;
  agentAvailable: boolean;
}

/**
 * Compat row consumed inside this hook — preserves the field names the rest
 * of the file already reads (`device_role`, `hardware_type`, `connection_*`,
 * `is_active`, `display_name`) while the underlying data source is the
 * canonical `device_assignments` table. (Wave 9b retired the
 * `useDeviceRegistry` shim entirely.)
 */
interface CompatDeviceRow {
  id: string;
  device_role: string;
  hardware_type: string;
  driver_type: string;
  connection_type: string;
  connection_params: Record<string, unknown>;
  display_name: string;
  is_active: boolean;
}

function toCompatRow(r: CanonicalAssignment): CompatDeviceRow {
  return {
    id: r.id,
    device_role: r.role,
    hardware_type: r.role,
    driver_type: r.driver,
    connection_type: r.transport,
    connection_params: r.config ?? {},
    display_name: r.display_name,
    is_active: r.enabled,
  };
}

/**
 * Convert a compat device row into the runtime DeviceAssignment shape the
 * browser-mode hardware adapter expects.
 *
 * CRITICAL: drivers read `connection_type` from `params.connection_type`
 * inside `connect()`. We inject the column value into the connectionParams
 * blob so drivers always have it.
 */
function toDeviceAssignment(config: CompatDeviceRow): DeviceAssignment {
  const connectionParams: Record<string, unknown> = {
    ...(config.connection_params ?? {}),
    connection_type: config.connection_type,
    id: config.id,
  };
  return {
    id: config.id,
    deviceRole: (config.device_role || config.hardware_type) as DeviceRole,
    driverType: (config.driver_type || 'browser_print') as DeviceAssignment['driverType'],
    connectionParams,
    displayName: config.display_name,
    isActive: config.is_active,
  };
}

const STATUS_POLL_INTERVAL_MS = 10_000;

export function useHardwareProxy(
  registerId?: string,
  options?: { disabled?: boolean; passive?: boolean },
) {
  const id = useRef(`useHardwareProxy-${Date.now()}-${Math.random()}`).current;

  // Read directly from the canonical `device_assignments` table.
  // Scope: if a registerId is supplied, ask for that register's rows plus
  // tenant defaults.
  const { assignments, isLoading: isLoadingDevices } = useDeviceAssignments(
    registerId ? { kind: 'register', id: registerId } : undefined,
  );
  const devices = useMemo<CompatDeviceRow[]>(
    () => assignments.map(toCompatRow),
    [assignments],
  );
  const disabled = options?.disabled ?? false;
  const passive = options?.passive ?? false;
  const [state, setState] = useState<HardwareProxyState>({
    isLoaded: false,
    isConnecting: false,
    deviceStatuses: new Map(),
    lastError: null,
    agentAvailable: hardwareClient.agent.isAvailable(),
  });

  const statusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevDeviceIdsRef = useRef<string>('');

  // Resync the status map from `hardwareClient.devices.getStatuses()` and
  // join role-level liveness back onto registry rows (keyed by device id).
  const refreshStatuses = useCallback(async () => {
    try {
      const live = await hardwareClient.devices.getStatuses();
      const byRole = new Map<DeviceRole, DeviceStatusDetail>();
      for (const s of live) byRole.set(s.role, s);

      const mapped = new Map<string, ProxyDeviceStatus>();
      for (const d of devices) {
        const role = (d.device_role || d.hardware_type) as DeviceRole;
        const s = byRole.get(role);
        mapped.set(d.id, {
          role,
          displayName: d.display_name,
          connected: s?.connected ?? false,
          status: s?.state ?? 'unknown',
          state: s?.state ?? 'unknown',
          lastError: s?.lastError,
          latencyMs: s?.latencyMs,
          lastPingAt: s?.lastPingAt,
          consecutiveFailures: s?.consecutiveFailures ?? 0,
        });
      }
      setState((prev) => ({ ...prev, deviceStatuses: mapped }));
    } catch {
      /* silent */
    }
  }, [devices]);

  // ── Load devices into the browser-mode runtime when registry changes ──
  useEffect(() => {
    if (disabled) return;
    if (isLoadingDevices || !devices) return;

    const deviceIds = devices.map((d) => d.id).sort().join(',');
    if (deviceIds === prevDeviceIdsRef.current && state.isLoaded) return;
    prevDeviceIdsRef.current = deviceIds;

    const assignments = devices.filter((d) => d.is_active).map(toDeviceAssignment);
    hardwareClient.devices.loadAssignments(assignments);
    setState((prev) => ({ ...prev, isLoaded: true }));

    if (!passive && assignments.length > 0 && !hardwareClient.devices.isElectron()) {
      setState((prev) => ({ ...prev, isConnecting: true }));
      hardwareClient.devices.connectAll().finally(() => {
        setState((prev) => ({ ...prev, isConnecting: false }));
        void refreshStatuses();
      });
    } else {
      void refreshStatuses();
    }
  }, [devices, disabled, isLoadingDevices, passive, refreshStatuses, state.isLoaded]);

  // ── Status polling + event-driven refresh (10 s tick + push refresh) ──
  useEffect(() => {
    if (disabled) return;
    if (!state.isLoaded) return;

    statusTimerRef.current = setInterval(() => {
      void refreshStatuses();
      if (!passive && !hardwareClient.devices.isElectron()) {
        void hardwareClient.devices.healthCheck();
      }
    }, STATUS_POLL_INTERVAL_MS);

    const offConn = hardwareClient.on('device:connected', () => void refreshStatuses());
    const offDisc = hardwareClient.on('device:disconnected', () => void refreshStatuses());
    const offErr = hardwareClient.on('device:error', () => void refreshStatuses());

    return () => {
      if (statusTimerRef.current) clearInterval(statusTimerRef.current);
      offConn();
      offDisc();
      offErr();
    };
  }, [disabled, passive, refreshStatuses, state.isLoaded]);

  // ── Agent lifecycle (browser path only — Electron bypasses the agent). ──
  //
  // Lifecycle rules (post audit):
  //   - `passive` consumers (read-only status badges, ReceiptPreviewDialog,
  //     anything that does NOT own the hardware session) MUST NOT call
  //     `disconnectAll` on unmount — that would tear down active hardware
  //     while another live consumer is still using it.
  //   - Only non-passive owners start the agent probe loop.
  //   - `agentClient.start/stop` is reference-counted internally, so calling
  //     stop here does not affect a sibling owner.
  //   - `setState` after an async `connectAll().then(...)` is guarded so we
  //     never write into an unmounted component (which previously kept the
  //     fiber alive after route changes).
  useEffect(() => {
    if (disabled) return;
    if (hardwareClient.devices.isElectron()) {
      setState((prev) => ({ ...prev, agentAvailable: false }));
      return;
    }
    if (passive) {
      // Passive consumers never own the agent loop or shared hardware
      // session. No cleanup side-effects.
      return;
    }

    let mounted = true;
    hardwareClient.agent.start(30_000);
    const unsubscribe = hardwareClient.agent.onChange((available) => {
      if (!mounted) return;
      setState((prev) => ({ ...prev, agentAvailable: available }));
      if (available) {
        void hardwareClient.devices
          .connectAll()
          .then(() => {
            if (mounted) void refreshStatuses();
          });
      }
    });

    return () => {
      mounted = false;
      hardwareClient.agent.stop();
      unsubscribe();
    };
    // Intentionally NOT depending on `refreshStatuses` — that callback's
    // identity changes whenever the device registry refetches, which would
    // otherwise tear down and restart the agent probe loop on every query
    // tick and re-trigger an immediate /status hit. We capture the latest
    // `refreshStatuses` via the closure above; stale closure is acceptable
    // here because the inner call just resyncs cached statuses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, passive]);

  useEffect(() => {
    // Mount tracker kept as a stable hook identity anchor; previous
    // [LIFECYCLE] console logs were stripped in Wave 9d (production noise).
    return () => undefined;
  }, [id]);

  // ═══════════════════════════════════════════
  //  Abstract action methods (what POS UI calls)
  // ═══════════════════════════════════════════

  const printReceipt = useCallback(async (receiptData: ReceiptData): Promise<DriverResult> => {
    const result = await hardwareClient.printReceipt({
      receiptData: {
        lines: receiptData.lines?.map((l) => ({
          text: typeof l === 'string' ? l : l.text || '',
          align: l.align,
          bold: l.bold,
        })) || [],
        header: receiptData.header,
        footer: receiptData.footer,
        cut: receiptData.cut !== false,
      } as never,
    });
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  /**
   * W4b (ADR-0008) — stream raw ESC/POS bytes (produced server-side by
   * `generate-document` with `format=escpos`) directly to the connected
   * receipt printer. Bypasses the client byte-builder entirely.
   */
  const printRawBytes = useCallback(async (bytes: Uint8Array | number[]): Promise<DriverResult> => {
    const result = await hardwareClient.printRawBytes(bytes);
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const printKitchenOrder = useCallback(async (orderData: ReceiptData): Promise<DriverResult> => {
    const result = await hardwareClient.printKitchenOrder({
      receiptData: {
        lines: orderData.lines?.map((l) => ({
          text: typeof l === 'string' ? l : l.text || '',
          align: l.align,
          bold: l.bold,
        })) || [],
        header: orderData.header,
        cut: true,
      } as never,
    });
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const openDrawer = useCallback(async (pin?: 2 | 5): Promise<DriverResult> => {
    const result = await hardwareClient.openDrawer({ pin });
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const readScale = useCallback(async (): Promise<DriverResult> => {
    const result = await hardwareClient.readScale();
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const tareScale = useCallback(async (): Promise<DriverResult> => {
    const result = await hardwareClient.tareScale();
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const updateDisplay = useCallback(async (data: unknown): Promise<DriverResult> => {
    const result = await hardwareClient.updateCustomerDisplay(data as never);
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const initiatePayment = useCallback(async (
    amount: number, currency: string, reference: string,
  ): Promise<DriverResult> => {
    const result = await hardwareClient.initiatePayment({ amount, currency, reference });
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const cancelPayment = useCallback(async (): Promise<DriverResult> => {
    const result = await hardwareClient.cancelPayment();
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  /**
   * Force-disconnect the printer for `role` and retry connect. Used by the
   * "Reconnect printer" button on PostPaymentScreen and by Test Connection.
   */
  const reconnectRole = useCallback(async (role: DeviceRole): Promise<DriverResult> => {
    const result = await hardwareClient.devices.reconnectRole(role);
    void refreshStatuses();
    return result;
  }, [refreshStatuses]);

  const isRoleAvailable = useCallback((role: DeviceRole): boolean => {
    return hardwareClient.devices.isRoleAvailable(role);
  }, []);

  const hasDeviceForRole = useCallback((role: DeviceRole): boolean => {
    return devices.some((d) => (d.device_role || d.hardware_type) === role && d.is_active);
  }, [devices]);

  const printerStatus = useCallback((): 'connected' | 'disconnected' | 'error' => {
    for (const [, info] of state.deviceStatuses) {
      if (info.role === 'receipt_printer') {
        if (info.connected) return 'connected';
        if (info.state === 'degraded' || info.status === 'error') return 'error';
      }
    }
    return 'disconnected';
  }, [state.deviceStatuses]);

  /**
   * Capability-driven destination list (Audit Wave 9d.6 P1).
   * Previous implementation hard-classified `label_printer` as 'a4' via a
   * string switch. Now kind comes from the true device role and 'browser'
   * is only offered when no physical a4 device is bound.
   */
  const availableDestinations = useCallback((): Array<{
    id: string;
    label: string;
    kind: 'thermal' | 'label' | 'a4' | 'browser';
    connected: boolean;
  }> => {
    const kindFor = (role: DeviceRole): 'thermal' | 'label' | 'a4' | null => {
      if (role === 'receipt_printer' || role === 'kitchen_printer') return 'thermal';
      if (role === 'label_printer') return 'label';
      if (role === 'a4_printer') return 'a4';
      return null;
    };
    const out: Array<{ id: string; label: string; kind: 'thermal' | 'label' | 'a4' | 'browser'; connected: boolean }> = [];
    let hasA4Device = false;
    for (const d of devices) {
      if (!d.is_active) continue;
      const role = (d.device_role || d.hardware_type) as DeviceRole;
      const kind = kindFor(role);
      if (!kind) continue;
      if (kind === 'a4') hasA4Device = true;
      const info = state.deviceStatuses.get(d.id);
      out.push({
        id: d.id,
        label: d.display_name || `${role}`,
        kind,
        connected: info?.connected ?? false,
      });
    }
    if (!hasA4Device) {
      out.push({ id: '__browser__', label: 'Browser / OS dialog', kind: 'browser', connected: true });
    }
    return out;
  }, [devices, state.deviceStatuses]);

  return {
    isLoaded: state.isLoaded,
    isConnecting: state.isConnecting,
    deviceStatuses: state.deviceStatuses,
    devices,
    agentAvailable: state.agentAvailable,
    printReceipt,
    printRawBytes,
    printKitchenOrder,
    openDrawer,
    readScale,
    tareScale,
    updateDisplay,
    initiatePayment,
    cancelPayment,
    isRoleAvailable,
    hasDeviceForRole,
    printerStatus,
    availableDestinations,
    refreshStatuses,
    reconnectRole,
    /** Per-role test-connection helper (Track H4). UI calls this from the
     *  device-registry card instead of poking the adapter directly. */
    testRoleConnection: hardwareClient.devices.testRoleConnection,
  };
}
