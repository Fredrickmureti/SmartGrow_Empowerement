/**
 * HardwareClient — the single chokepoint for all POS UI hardware calls.
 *
 * RULE: POS UI code (hooks, components, pages, apps) MUST import from
 * `hardwareClient`. The renderer-side shells `BrowserHardwareAdapter`,
 * `local-agent/AgentClient`, `local-display/CustomerDisplayClient` are
 * service-internal; the `no-legacy-hardware-shell` guard test enforces
 * this rule.
 *
 * ADR-0014 Track 4b.5 — Dual-adapter model:
 *   - Electron path: `window.pos.hardware.exec` → main-process CommandRouter
 *     (idempotent, audited, queued, retried). Production runtime.
 *   - Browser path: `browserHardwareAdapter.exec` → renderer-side driver
 *     runtime backed by WebUSB / WebSerial / local-agent HTTP. Dev preview
 *     and mobile-web POS.
 *
 * Both adapters speak the same `(role, op, payload)` envelope so no
 * platform branching leaks into UI code. This is the Shopify POS pattern.
 *
 * Track H4 — three sub-namespaces collapse what used to be a half-dozen
 * scattered singletons:
 *   - `hardwareClient.devices.*`        — liveness, lifecycle, capability
 *   - `hardwareClient.customerDisplay.*`— secondary-window orchestration
 *   - `hardwareClient.agent.*`          — local-agent HTTP bridge (browser only)
 */

import { browserHardwareAdapter, type DeviceAssignment } from "./BrowserHardwareAdapter";
import { hardwareEventBus, type HardwareEvent, type HardwareEventType } from "./HardwareEventBus";
import type { DeviceRole, DriverCommand, DriverResult } from "./drivers/DriverInterface";
import { agentClient } from "./local-agent/AgentClient";
import type { RelayConfig } from "./local-agent/RelayTransport";
import { customerDisplayClient, type CustomerDisplayData, type CustomerDisplayConfig } from "./local-display/CustomerDisplayClient";
import type { AgentStatusResponse, AgentDeviceInfo } from "./local-agent/protocol";
import { recordHardwareExec, getHardwareExecContext, getRecentExecLog } from "./HardwareExecLog";
import { supabase } from "@/integrations/supabase/client";

export { getRecentExecLog, setHardwareExecContext } from "./HardwareExecLog";
export type { HardwareExecLogEntry } from "./HardwareExecLog";

function ipcAvailable(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { pos?: { hardware?: { exec?: unknown } } }).pos?.hardware?.exec);
}

function isElectronMode(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron);
}

function newKey(): string {
  try {
    return (globalThis.crypto?.randomUUID?.() ?? `hc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  } catch {
    return `hc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function execElectron(role: DeviceRole, op: string, payload: unknown, idempotencyKey?: string, maxAttempts?: number): Promise<DriverResult> {
  const pos = (window as unknown as { pos: { hardware: { exec: (cmd: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }> } } }).pos;
  const res = await pos.hardware.exec({
    role,
    op,
    payload,
    idempotencyKey: idempotencyKey ?? newKey(),
    maxAttempts,
  });
  return res.ok
    ? { success: true, data: res.result as never }
    : { success: false, error: res.error ?? "exec failed" };
}

// ── Wave 6 — runtime-reason instrumentation ────────────────────────────
//
// Every `execAny` call records which transport the resolver picked and why.
// The HardwareDiagnostics page reads `getRecentRuntimeReasons()` to surface
// the last-N decisions so operators can see "this print went via the local
// agent because Electron IPC was unavailable" without having to reproduce
// the failure mode.

export type RuntimeReason =
  | "electron-bypass"
  | "browser-direct"
  | "electron-fallback-unexpected";

interface RuntimeReasonEntry {
  at: number;
  role: DeviceRole;
  op: string;
  reason: RuntimeReason;
}

const RUNTIME_REASON_RING: RuntimeReasonEntry[] = [];
const RUNTIME_REASON_RING_MAX = 50;

function recordReason(role: DeviceRole, op: string, reason: RuntimeReason) {
  RUNTIME_REASON_RING.push({ at: Date.now(), role, op, reason });
  if (RUNTIME_REASON_RING.length > RUNTIME_REASON_RING_MAX) {
    RUNTIME_REASON_RING.shift();
  }
}

export function getRecentRuntimeReasons(): ReadonlyArray<RuntimeReasonEntry> {
  return RUNTIME_REASON_RING.slice();
}

export interface HardwareExecAudit {
  sourceDocType?: string | null;
  sourceDocId?: string | null;
  businessEventId?: string | null;
  isReprint?: boolean;
}

/**
 * Back-compat helper — older call sites (BusinessSagaMount before Track A,
 * labelDispatch before Track A) put audit fields inside `payload`. Peel
 * them off so the audit columns get populated regardless of the call shape.
 */
function peelAuditFromPayload(payload: unknown, audit?: HardwareExecAudit): HardwareExecAudit {
  if (audit && (audit.sourceDocId || audit.businessEventId)) return audit;
  if (!payload || typeof payload !== 'object') return audit ?? {};
  const p = payload as Record<string, unknown>;
  return {
    sourceDocType: (audit?.sourceDocType ?? (p.sourceDocType as string | undefined)) ?? null,
    sourceDocId: (audit?.sourceDocId ?? (p.sourceDocId as string | undefined)) ?? null,
    businessEventId: (audit?.businessEventId ?? (p.businessEventId as string | undefined)) ?? null,
    isReprint: audit?.isReprint ?? (p.isReprint as boolean | undefined) ?? false,
  };
}

async function execAny(
  role: DeviceRole,
  op: string,
  payload: unknown,
  idempotencyKey?: string,
  maxAttempts?: number,
  audit?: HardwareExecAudit,
): Promise<DriverResult> {
  const startedAt = Date.now();
  let reason: RuntimeReason;
  let result: DriverResult;
  try {
    if (ipcAvailable()) {
      reason = "electron-bypass";
      recordReason(role, op, reason);
      result = await execElectron(role, op, payload, idempotencyKey, maxAttempts);
    } else if (isElectronMode()) {
      console.warn(
        `[HardwareClient] Electron detected but main-process IPC unavailable — falling back to renderer driver for ${role}.${op}. Repackage the desktop app to update preload.`,
      );
      reason = "electron-fallback-unexpected";
      recordReason(role, op, reason);
      result = await browserHardwareAdapter.exec({ role, op, payload, idempotencyKey, maxAttempts });
    } else {
      reason = "browser-direct";
      recordReason(role, op, reason);
      result = await browserHardwareAdapter.exec({ role, op, payload, idempotencyKey, maxAttempts });
    }
    return result;
  } finally {
    try {
      const ctx = getHardwareExecContext();
      const a = peelAuditFromPayload(payload, audit);
      // Audit Wave 9d.7 P4 + Track A — actorUserId is resolved inside the
      // batched flusher (cached for SESSION_TTL_MS); source-doc linkage is
      // now propagated end-to-end so hardware_exec_log rows can answer
      // "show every print attempt for GRN-00123".
      recordHardwareExec({
        at: startedAt,
        role,
        op,
        ok: !!result! && result!.success,
        durationMs: Date.now() - startedAt,
        errorMessage: result! && !result!.success ? result!.error : undefined,
        idempotencyKey,
        runtimeReason: reason!,
        orgId: ctx.orgId,
        businessId: ctx.businessId,
        actorUserId: null,
        sourceDocType: a.sourceDocType ?? null,
        sourceDocId: a.sourceDocId ?? null,
        businessEventId: a.businessEventId ?? null,
        isReprint: a.isReprint ?? false,
      });
    } catch { /* log writes never throw */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════

export interface PrintReceiptInput {
  receiptData: DriverCommand["payload"];
}

function payloadHasRawBytes(payload: unknown): boolean {
  if (payload instanceof Uint8Array) return true;
  if (Array.isArray(payload)) return payload.every((b) => typeof b === 'number');
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const bytes = p.bytes ?? p.data;
  return bytes instanceof Uint8Array || (Array.isArray(bytes) && bytes.every((b) => typeof b === 'number'));
}

export interface OpenDrawerInput {
  pin?: 2 | 5;
}

export interface InitiatePaymentInput {
  amount: number;
  currency: string;
  reference: string;
}

/** Honest, per-role liveness snapshot from the main-process DeviceManager
 * (or the renderer-side adapter in browser dev). UI badges read from here. */
export interface DeviceStatusDetail {
  role: DeviceRole;
  transport?: string;
  driver?: string;
  connected: boolean;
  /** `connected` (healthy) | `degraded` (failing pings, still bound) |
   *  `disconnected` (open breaker) | `unknown` (no probe yet). */
  state: 'connected' | 'degraded' | 'disconnected' | 'unknown';
  latencyMs?: number;
  lastPingAt?: number;
  lastError?: string;
  consecutiveFailures?: number;
}

export interface AgentStatusSnapshot {
  available: boolean;
  authorized: boolean;
  baseUrl: string;
  version?: string | null;
  devices?: AgentDeviceInfo[];
  /** Why the agent path is not in use. `electron-bypass` in desktop mode. */
  reason?: 'electron-bypass' | 'offline' | 'unauthorized' | 'ok';
}

export type { CustomerDisplayData, CustomerDisplayConfig };

// ═══════════════════════════════════════════════════════════════════════
//  Runtime capability probe (Wave 9d)
// ═══════════════════════════════════════════════════════════════════════
//
// Single source of truth for "what can this runtime actually do right now?".
// Three branches:
//   - Electron: ask the preload (`window.pos.hardware.capabilities()`),
//     which delegates to the main-process probe.
//   - IoT-agent (browser with `localhost:8043` reachable): map the agent's
//     status into the same shape.
//   - Browser-only: feature-detect WebUSB / WebSerial / WebHID.
//
// The Runtime card on /platform/hardware/devices renders this. Any future
// caller (diagnostics, support tooling) should use this instead of
// re-deriving capabilities ad-hoc.

export type HardwareTransportState = 'native' | 'unavailable' | 'degraded';

export interface RuntimeCapability {
  runtime: 'electron' | 'iot-agent' | 'browser' | 'unsupported';
  platform: string;
  preloadBuild?: string;
  agentBaseUrl?: string;
  transports: {
    usb: HardwareTransportState;
    serial: HardwareTransportState;
    hid: HardwareTransportState;
    network: HardwareTransportState;
    cups: HardwareTransportState;
    bluetooth: HardwareTransportState;
  };
  ops: string[];
  /** Plain-language degraded warnings for operator display. */
  warnings: string[];
}

const UNAVAILABLE = 'unavailable' as const;
const NATIVE = 'native' as const;

function browserCapability(): RuntimeCapability {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const usb: HardwareTransportState = nav && 'usb' in nav ? NATIVE : UNAVAILABLE;
  const serial: HardwareTransportState = nav && 'serial' in nav ? NATIVE : UNAVAILABLE;
  const hid: HardwareTransportState = nav && 'hid' in nav ? NATIVE : UNAVAILABLE;
  const warnings: string[] = [];
  if (usb !== NATIVE) warnings.push('WebUSB unavailable — Chromium/Edge required for direct printer/scanner access.');
  if (serial !== NATIVE) warnings.push('WebSerial unavailable — scale read-out and serial printers will not work in this browser.');
  return {
    runtime: usb === NATIVE || serial === NATIVE || hid === NATIVE ? 'browser' : 'unsupported',
    platform: nav?.platform ?? 'unknown',
    transports: { usb, serial, hid, network: NATIVE, cups: UNAVAILABLE, bluetooth: UNAVAILABLE },
    ops: ['print_receipt', 'print_raw'],
    warnings,
  };
}

async function agentCapability(): Promise<RuntimeCapability | null> {
  const status = await agentClient.probe();
  if (!status?.running) return null;
  return {
    runtime: 'iot-agent',
    platform: 'iot-agent',
    agentBaseUrl: agentClient.getBaseUrl(),
    transports: {
      usb: NATIVE, serial: NATIVE, hid: 'degraded',
      network: NATIVE, cups: UNAVAILABLE, bluetooth: UNAVAILABLE,
    },
    ops: ['print_receipt', 'print_raw', 'open'],
    warnings: agentClient.isAuthorized() ? [] : ['Local agent reachable but not authorized — paste the agent token in POS settings → Hardware.'],
  };
}

let _capCache: { at: number; cap: RuntimeCapability } | null = null;
const CAP_TTL_MS = 5_000;

/**
 * Live capability probe. Cached for 5s to avoid hammering the preload on
 * every render. Call `invalidateRuntimeCapability()` after reconnecting the
 * agent or after `pos.hardware.exec` reports a transport-level failure.
 */
export async function runtimeCapability(): Promise<RuntimeCapability> {
  if (_capCache && Date.now() - _capCache.at < CAP_TTL_MS) return _capCache.cap;
  let cap: RuntimeCapability;
  if (ipcAvailable()) {
    try {
      const pos = (window as unknown as { pos: { hardware: { capabilities: () => Promise<{
        ok?: boolean; runtime?: string; platform?: string; preloadBuild?: string;
        transports?: RuntimeCapability['transports']; ops?: string[];
      }> } } }).pos;
      const snap = await pos.hardware.capabilities();
      const warnings: string[] = [];
      const t = snap.transports;
      if (t) {
        for (const [name, state] of Object.entries(t)) {
          if (state === UNAVAILABLE && name !== 'cups') {
            warnings.push(`${name} transport unavailable in main process — peripheral access for this transport will fail.`);
          }
          if (state === 'degraded') warnings.push(`${name} transport degraded — check device permissions / udev rules.`);
        }
      }
      cap = {
        runtime: 'electron',
        platform: snap.platform ?? 'electron',
        preloadBuild: snap.preloadBuild,
        transports: snap.transports ?? browserCapability().transports,
        ops: snap.ops ?? [],
        warnings,
      };
    } catch (err) {
      cap = {
        runtime: 'electron', platform: 'electron',
        transports: browserCapability().transports, ops: [],
        warnings: [`Capability probe failed: ${(err as Error).message}. Preload bundle may be stale — repackage the desktop client.`],
      };
    }
  } else if (isElectronMode()) {
    cap = {
      runtime: 'electron', platform: 'electron',
      transports: browserCapability().transports, ops: [],
      warnings: ['Inside Electron but the preload hardware bridge is missing. Repackage the desktop app — the renderer is running against a stale preload bundle.'],
    };
  } else {
    const agent = await agentCapability();
    cap = agent ?? browserCapability();
  }
  _capCache = { at: Date.now(), cap };
  return cap;
}

export function invalidateRuntimeCapability(): void {
  _capCache = null;
}



// ═══════════════════════════════════════════════════════════════════════
//  Devices namespace — liveness, lifecycle, capability
// ═══════════════════════════════════════════════════════════════════════

const devices = {
  /** Async, honest per-role liveness. Preferred over the sync availability check. */
  async getStatuses(): Promise<DeviceStatusDetail[]> {
    if (ipcAvailable()) {
      const pos = (window as unknown as {
        pos: { devices: { status: () => Promise<{ ok: boolean; statuses?: Array<DeviceStatusDetail & { role: string }>; error?: string }> } }
      }).pos;
      const r = await pos.devices.status();
      if (!r.ok || !r.statuses) return [];
      return r.statuses.map((s) => ({
        role: s.role as DeviceRole,
        transport: s.transport,
        driver: s.driver,
        connected: Boolean(s.connected),
        state: (s.state ?? (s.connected ? 'connected' : 'unknown')) as DeviceStatusDetail['state'],
        latencyMs: s.latencyMs,
        lastPingAt: s.lastPingAt,
        lastError: s.lastError,
        consecutiveFailures: s.consecutiveFailures ?? 0,
      }));
    }
    const out: DeviceStatusDetail[] = [];
    for (const [, s] of browserHardwareAdapter.getAllStatuses()) {
      const connected = s.status.connected;
      out.push({
        role: s.role,
        connected,
        state: connected ? 'connected' : (s.lastError ? 'degraded' : 'disconnected'),
        lastError: s.lastError,
      });
    }
    return out;
  },

  /** Force a reconnect of a single role; sibling handlers are not touched. */
  async reconnectRole(role: DeviceRole): Promise<DriverResult> {
    if (ipcAvailable()) {
      const pos = (window as unknown as { pos: { devices: { reconnect: (role: string) => Promise<{ ok: boolean; error?: string }> } } }).pos;
      const r = await pos.devices.reconnect(role);
      return r.ok ? { success: true } : { success: false, error: r.error ?? 'reconnect failed' };
    }
    return browserHardwareAdapter.reconnectRole(role);
  },

  /** Synchronous capability hint — UI badges should prefer `getStatuses()`. */
  isRoleAvailable(role: DeviceRole): boolean {
    if (ipcAvailable()) return true;
    return browserHardwareAdapter.isRoleAvailable(role);
  },

  /** Per-role test-connection used by the device-registry settings card. */
  async testRoleConnection(role: DeviceRole): Promise<{ success: boolean; error?: string }> {
    if (ipcAvailable()) {
      // Reconnect doubles as a liveness probe in Electron (DeviceManager.refresh
      // re-runs the ping immediately and reports the result).
      const r = await this.reconnectRole(role);
      return { success: !!r.success, error: r.error };
    }
    const driver = browserHardwareAdapter.getDriverForRole(role);
    if (!driver) return { success: false, error: `No driver bound for role: ${role}` };
    try {
      const healthy = await driver.testConnection();
      return { success: healthy, error: healthy ? undefined : 'Device did not respond' };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },

  // ── Browser-only lifecycle (no-ops in Electron — DeviceManager owns it). ──

  loadAssignments(assignments: DeviceAssignment[]): void {
    if (ipcAvailable()) return;
    browserHardwareAdapter.loadDevices(assignments);
  },

  async connectAll(): Promise<void> {
    if (ipcAvailable()) return;
    await browserHardwareAdapter.connectAll();
  },

  async disconnectAll(): Promise<void> {
    if (ipcAvailable()) return;
    await browserHardwareAdapter.disconnectAll();
  },

  async healthCheck(): Promise<void> {
    if (ipcAvailable()) return;
    await browserHardwareAdapter.healthCheck();
  },

  isElectron(): boolean {
    return isElectronMode();
  },
};

// ═══════════════════════════════════════════════════════════════════════
//  Customer-display namespace — secondary-window orchestration
// ═══════════════════════════════════════════════════════════════════════

const customerDisplay = {
  isAvailable(): boolean {
    return customerDisplayClient.isAvailable();
  },
  async getDisplays() {
    return customerDisplayClient.getDisplays();
  },
  async open(config?: CustomerDisplayConfig) {
    return customerDisplayClient.open(config);
  },
  async close() {
    return customerDisplayClient.close();
  },
  async update(data: CustomerDisplayData) {
    return customerDisplayClient.update(data);
  },
  async showMessage(message: string, status?: CustomerDisplayData['status']) {
    return customerDisplayClient.showMessage(message, status);
  },
  async showComplete(total: number, customerName?: string) {
    return customerDisplayClient.showComplete(total, customerName);
  },
  async reset() {
    return customerDisplayClient.reset();
  },
  isConnected(): boolean {
    return customerDisplayClient.isDisplayConnected();
  },
  async isOpen(): Promise<boolean> {
    if (isElectronMode()) {
      try {
        const pos = (window as unknown as { pos?: { app?: { customerDisplay?: { isOpen?: () => Promise<boolean> } } } }).pos;
        return Boolean(await pos?.app?.customerDisplay?.isOpen?.());
      } catch {
        return false;
      }
    }
    return customerDisplayClient.isDisplayConnected();
  },
  /**
   * Re-attach the renderer's `isConnected` state to a still-living
   * Electron secondary window after a cashier-side reload, and replay
   * the last payload so the screen never appears stuck. No-op outside
   * Electron or when no secondary window is open.
   */
  async rebindIfElectronWindowOpen(): Promise<boolean> {
    return customerDisplayClient.rebindIfElectronWindowOpen();
  },
};

// ═══════════════════════════════════════════════════════════════════════
//  Agent namespace — local-agent HTTP bridge (browser/dev only)
// ═══════════════════════════════════════════════════════════════════════

const agent = {
  /** True when the agent path is in use. In Electron, always false — the
   *  main-process CommandRouter owns hardware IO instead. */
  isAvailable(): boolean {
    if (isElectronMode()) return false;
    return agentClient.isAvailable();
  },
  isAuthorized(): boolean {
    if (isElectronMode()) return false;
    return agentClient.isAuthorized();
  },
  getBaseUrl(): string {
    return agentClient.getBaseUrl();
  },
  setBaseUrl(url: string): void {
    agentClient.setBaseUrl(url);
  },
  getToken(): string | null {
    return agentClient.getToken();
  },
  setToken(token: string | null): void {
    agentClient.setToken(token);
  },
  enableRelay(config: RelayConfig): void {
    if (isElectronMode()) return;
    agentClient.enableRelay(supabase, config);
  },
  disableRelay(): void {
    agentClient.disableRelay();
  },
  isRelayEnabled(): boolean {
    return agentClient.isRelayEnabled();
  },
  getRelayConfig(): RelayConfig | null {
    return agentClient.getRelayConfig();
  },
  async probe(): Promise<AgentStatusResponse | null> {
    if (isElectronMode()) return null;
    return agentClient.probe();
  },
  async status(): Promise<AgentStatusSnapshot> {
    if (isElectronMode()) {
      return { available: false, authorized: false, baseUrl: agentClient.getBaseUrl(), reason: 'electron-bypass' };
    }
    const probed = await agentClient.probe();
    const available = !!probed?.running;
    const authorized = agentClient.isAuthorized();
    return {
      available,
      authorized,
      baseUrl: agentClient.getBaseUrl(),
      version: probed?.version ?? null,
      devices: probed?.devices,
      reason: !available ? 'offline' : (authorized ? 'ok' : 'unauthorized'),
    };
  },
  /** Send raw bytes to a network printer via the agent. Used by the
   *  loopback "send test print" button on the hardware settings page. */
  async testPrintNetwork(ipAddress: string, port: number, bytes: number[]) {
    if (isElectronMode()) {
      return { success: false, error: 'Agent path is bypassed in Electron — use the Reconnect/Test buttons on the device row instead.' };
    }
    return agentClient.printNetwork(ipAddress, port, bytes);
  },
  onChange(cb: (available: boolean, status: AgentStatusResponse | null) => void): () => void {
    if (isElectronMode()) return () => undefined;
    return agentClient.onChange(cb);
  },
  start(intervalMs?: number): void {
    if (isElectronMode()) return;
    agentClient.start(intervalMs);
  },
  stop(): void {
    if (isElectronMode()) return;
    agentClient.stop();
  },
};

/**
 * POS-facing hardware API. Stable across the Electron / browser split.
 */
export const hardwareClient = {
  // === Receipt / kitchen printing ===
  printReceipt(input: PrintReceiptInput): Promise<DriverResult> {
    if (!payloadHasRawBytes(input.receiptData)) {
      return Promise.resolve({
        success: false,
        error: 'Receipt printing requires server-rendered ESC/POS bytes. Structured receiptData is refused to prevent renderer divergence.',
      });
    }
    return execAny("receipt_printer", "print_receipt", input.receiptData);
  },
  printKitchenOrder(input: PrintReceiptInput): Promise<DriverResult> {
    return execAny("kitchen_printer", "print_receipt", input.receiptData);
  },
  printRawBytes(bytes: Uint8Array | number[]): Promise<DriverResult> {
    return execAny("receipt_printer", "print_raw", Array.from(bytes));
  },
  /**
   * Audit Wave 9d.3 — first-class label-printer entrypoint. Routes to the
   * `label_printer` role (which now has a real driver + handler chain in
   * Electron and a fallback path in the browser adapter) instead of
   * piggy-backing on `receipt_printer:print_raw`. Cross-module callers
   * (Inventory, Warehouse, Manufacturing) should use this.
   */
  printLabelBytes(bytes: Uint8Array | number[]): Promise<DriverResult> {
    return execAny("label_printer", "print_raw", Array.from(bytes));
  },

  // === Cash drawer ===
  openDrawer(input: OpenDrawerInput = {}): Promise<DriverResult> {
    return execAny("cash_drawer", "open", { pin: input.pin });
  },

  // === Scale ===
  readScale(): Promise<DriverResult> {
    return execAny("scale", "read", {});
  },
  tareScale(): Promise<DriverResult> {
    return execAny("scale", "tare", {});
  },

  // === Customer display (low-level driver op — prefer `customerDisplay.*`) ===
  updateCustomerDisplay(data: DriverCommand["payload"]): Promise<DriverResult> {
    return execAny("customer_display", "update", data);
  },

  // === Payment terminal ===
  initiatePayment(input: InitiatePaymentInput): Promise<DriverResult> {
    return execAny("payment_terminal", "initiate_payment", input);
  },
  cancelPayment(): Promise<DriverResult> {
    return execAny("payment_terminal", "cancel_payment", {});
  },

  // === Generic exec (Track 4b.4 + Track A audit linkage) ===
  exec(cmd: {
    role: DeviceRole;
    op: string;
    payload?: unknown;
    idempotencyKey?: string;
    maxAttempts?: number;
    /** Track A — link this hardware action to the source business document. */
    sourceDocType?: string | null;
    sourceDocId?: string | null;
    businessEventId?: string | null;
    isReprint?: boolean;
  }): Promise<DriverResult> {
    return execAny(cmd.role, cmd.op, cmd.payload, cmd.idempotencyKey, cmd.maxAttempts, {
      sourceDocType: cmd.sourceDocType,
      sourceDocId: cmd.sourceDocId,
      businessEventId: cmd.businessEventId,
      isReprint: cmd.isReprint,
    });
  },

  // === Namespaces (Track H4) ===
  devices,
  customerDisplay,
  agent,

  // === Bluetooth pairings (Track B-UI) — Electron-only ===
  bluetooth: {
    async radioAvailable(): Promise<boolean> {
      if (!ipcAvailable()) return false;
      const pos = (window as unknown as { pos: { bluetooth: { radioAvailable: () => Promise<{ ok: boolean }> } } }).pos;
      try { return (await pos.bluetooth.radioAvailable()).ok; } catch { return false; }
    },
    async list() {
      if (!ipcAvailable()) return { ok: false as const, error: 'bluetooth requires Electron' };
      const pos = (window as unknown as { pos: { bluetooth: { list: () => Promise<unknown> } } }).pos;
      return pos.bluetooth.list() as Promise<{ ok: true; data?: unknown[] } | { ok: false; error: string }>;
    },
    async pair(input: { deviceId: string; mac: string; name?: string | null; role: string; autoReconnect?: boolean }) {
      if (!ipcAvailable()) return { ok: false as const, error: 'bluetooth requires Electron' };
      const pos = (window as unknown as { pos: { bluetooth: { pair: (i: typeof input) => Promise<unknown> } } }).pos;
      return pos.bluetooth.pair(input) as Promise<{ ok: true } | { ok: false; error: string }>;
    },
    async unpair(deviceId: string) {
      if (!ipcAvailable()) return { ok: false as const, error: 'bluetooth requires Electron' };
      const pos = (window as unknown as { pos: { bluetooth: { unpair: (id: string) => Promise<unknown> } } }).pos;
      return pos.bluetooth.unpair(deviceId) as Promise<{ ok: true } | { ok: false; error: string }>;
    },
    async connect(deviceId: string) {
      if (!ipcAvailable()) return { ok: false as const, error: 'bluetooth requires Electron' };
      const pos = (window as unknown as { pos: { bluetooth: { connect: (id: string) => Promise<unknown> } } }).pos;
      return pos.bluetooth.connect(deviceId) as Promise<{ ok: true } | { ok: false; error: string }>;
    },
    async disconnect(deviceId: string) {
      if (!ipcAvailable()) return { ok: false as const, error: 'bluetooth requires Electron' };
      const pos = (window as unknown as { pos: { bluetooth: { disconnect: (id: string) => Promise<unknown> } } }).pos;
      return pos.bluetooth.disconnect(deviceId) as Promise<{ ok: true } | { ok: false; error: string }>;
    },
  },

  // === Legacy root-level forwarders — kept for one loop to avoid a giant
  // ripple. New callers MUST go through the namespaces. ===
  isRoleAvailable(role: DeviceRole): boolean {
    return devices.isRoleAvailable(role);
  },
  async getStatuses(): Promise<DeviceStatusDetail[]> {
    return devices.getStatuses();
  },
  async reconnectRole(role: DeviceRole): Promise<DriverResult> {
    return devices.reconnectRole(role);
  },

  // === Events ===
  on(type: HardwareEventType, cb: (event: HardwareEvent) => void): () => void {
    return hardwareEventBus.on(type, cb);
  },

  /** ADR-0014 Track C2 — emit a sale-committed message; saga handles the rest. */
  emitSaleCommitted(payload: { saleId: string; receipt?: unknown; drawer?: unknown; display?: unknown; gl?: unknown }): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
    if (!ipcAvailable()) return Promise.resolve({ ok: false, error: "not in Electron" });
    const pos = (window as unknown as { pos: { sale: { committed: typeof hardwareClient.emitSaleCommitted } } }).pos;
    return pos.sale.committed(payload) as Promise<{ ok: boolean; queued?: boolean; error?: string }>;
  },
};

export type HardwareClient = typeof hardwareClient;
