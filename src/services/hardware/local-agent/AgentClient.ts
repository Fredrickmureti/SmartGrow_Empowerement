/**
 * AgentClient — local-agent HTTP client (browser/dev path only).
 *
 * Track H4 (ADR-0014). Formerly `IoTBoxClient.ts`; moved here so the
 * public hardware surface in `HardwareClient.agent.*` can wrap it
 * without leaking the legacy name into hooks/components.
 *
 * This is our equivalent of Odoo's IoT Box: a lightweight HTTP service
 * running on localhost (or LAN) that bridges the browser to USB/network
 * printers via raw TCP/USB.
 *
 * Lifecycle:
 *   start()       → begin periodic probing
 *   stop()        → stop probing
 *   isAvailable()  → cached availability (fast, no I/O)
 *   probe()        → force a status check
 *   printNetwork() → send bytes to a network printer via agent
 *   printUsb()     → send bytes to a USB printer via agent
 *   testConnection() → test TCP connectivity via agent
 *   discoverDevices() → auto-detect devices on LAN
 *   listUsbDevices()  → list USB devices on agent host
 *
 * Agent HTTP API (see local-agent/protocol.ts for types):
 *   GET  /status            → AgentStatusResponse
 *   POST /print             → AgentPrintRequest  → AgentPrintResponse
 *   POST /test              → AgentTestRequest   → AgentTestResponse
 *   GET  /discover?subnet=auto → AgentDiscoverResponse
 *   POST /usb/print         → AgentUsbPrintRequest → AgentPrintResponse
 *   GET  /usb/devices       → AgentUsbDevicesResponse
 */

import type {
  AgentStatusResponse,
  AgentPrintResponse,
  AgentTestResponse,
  AgentDiscoverResponse,
  AgentUsbDevicesResponse,
  AgentDeviceInfo,
} from './protocol';
import { DEFAULT_AGENT_URL } from './protocol';
import { RelayTransport, type RelayConfig } from './RelayTransport';
import type { SupabaseClient } from '@supabase/supabase-js';

type AgentChangeCallback = (available: boolean, status: AgentStatusResponse | null) => void;

const TOKEN_STORAGE_KEY = 'pos.agent.token';
const URL_STORAGE_KEY = 'pos.agent.url';
const RELAY_STORAGE_KEY = 'pos.agent.relay';

// Circuit-breaker tuning. Optional hardware MUST NOT spam the console or the
// network with retries when the local agent is absent. We start at the
// caller-requested interval and back off exponentially on consecutive
// failures, capped, until the agent comes back or the user clicks Test.
const MIN_PROBE_INTERVAL_MS = 5_000;
const MAX_PROBE_INTERVAL_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 1_500;

class AgentClientImpl {
  private _baseUrl: string;
  private _token: string | null = null;
  private _status: AgentStatusResponse | null = null;
  private _lastProbeTime = 0;
  private _probing = false;
  private _probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reference count of active monitor owners. The probe loop only runs when > 0. */
  private _startRefs = 0;
  private _baseIntervalMs = 30_000;
  private _nextDelayMs = 30_000;
  private _consecutiveFailures = 0;
  private _listeners = new Set<AgentChangeCallback>();
  private _lastAvailable = false;
  /** True when /status is reachable AND a protected probe (HEAD /discover) succeeds. */
  private _lastAuthorized = false;

  /**
   * Wave B4.2 — per-endpoint mutex.
   *
   * Concurrent print/test calls against the *same* physical endpoint must
   * serialize: most thermal/label printers accept exactly one TCP/USB session
   * at a time, and interleaving raw ESC/POS bytes from two callers produces
   * a corrupt receipt or a hung socket. Calls against *different* endpoints
   * stay parallel.
   *
   * Authority is split with the DB-side per-assignment lock from B4.1:
   *  - DB guarantees per-assignment FIFO across workers / tabs.
   *  - This mutex guarantees per-endpoint FIFO inside a single tab, including
   *    UI flows that bypass the shared queue (Test button, manual reprint).
   * The two are complementary, not redundant.
   *
   * Keyed by `${transport}:${normalize(address)}`. The map entry is cleared
   * in a finally block once the chain settles, so a never-resolving fetch
   * cannot leak — the entry is replaced as new callers arrive.
   */
  private _endpointLocks = new Map<string, Promise<unknown>>();

  /**
   * Phase 2 relay transport. When configured (via `enableRelay()`), the
   * client routes mutating operations through Supabase edge_jobs first
   * and falls back to loopback HTTP only if the relay dispatch fails or
   * times out. This is what unblocks production `https://` origins where
   * mixed-content rules forbid a direct fetch to `http://127.0.0.1`.
   */
  private _relay: RelayTransport | null = null;
  private _relayConfig: RelayConfig | null = null;

  /** Normalize a network endpoint key. Lowercases host, strips default ports. */
  private _netKey(ipAddress: string, port: number): string {
    const host = (ipAddress ?? '').trim().toLowerCase();
    // 9100 is the raw-TCP printer default; 80/443 are HTTP defaults.
    const omit = port === 9100 || port === 80 || port === 443;
    return `net:${host}${omit ? '' : `:${port}`}`;
  }

  /** Normalize a USB endpoint key. */
  private _usbKey(vendorId: number, productId: number, serial?: string | null): string {
    const v = Number(vendorId).toString(16).padStart(4, '0');
    const p = Number(productId).toString(16).padStart(4, '0');
    return `usb:${v}:${p}:${serial ?? ''}`;
  }

  /**
   * Serialize `fn` against any other in-flight call sharing the same `key`.
   * Different keys run in parallel. The tail-of-chain check prevents the
   * map from growing unbounded.
   */
  private async _withEndpointLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._endpointLocks.get(key) ?? Promise.resolve();
    // Swallow any rejection from prev — we only need ordering, not propagation.
    const gate = prev.catch(() => undefined);
    const run = gate.then(fn);
    this._endpointLocks.set(key, run);
    try {
      return await run;
    } finally {
      // Only clear if we are still the tail; otherwise a later caller owns the slot.
      if (this._endpointLocks.get(key) === run) {
        this._endpointLocks.delete(key);
      }
    }
  }

  constructor(baseUrl = DEFAULT_AGENT_URL) {
    // Hydrate persisted url/token if available (browser only)
    try {
      if (typeof localStorage !== 'undefined') {
        const savedUrl = localStorage.getItem(URL_STORAGE_KEY);
        const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
        if (savedUrl) baseUrl = savedUrl;
        if (savedToken) this._token = savedToken;
      }
    } catch { /* ignore storage errors */ }
    this._baseUrl = baseUrl;
  }

  /** Set/clear the agent shared-secret token. Persisted to localStorage. */
  setToken(token: string | null): void {
    this._token = token && token.trim().length > 0 ? token.trim() : null;
    try {
      if (typeof localStorage !== 'undefined') {
        if (this._token) localStorage.setItem(TOKEN_STORAGE_KEY, this._token);
        else localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
    } catch { /* ignore */ }
    // Force re-auth check on next probe
    this._lastAuthorized = false;
    this._lastProbeTime = 0;
  }

  getToken(): string | null {
    return this._token;
  }

  /** True only when /status responds AND protected calls are authorized. */
  isAuthorized(): boolean {
    return this._lastAuthorized;
  }

  // ═══════════════════════════════════════════
  //  Phase 2 relay transport (Supabase edge_jobs)
  // ═══════════════════════════════════════════

  /**
   * Enable the Supabase relay transport. When enabled, mutating hardware
   * ops (`printNetwork`, `printUsb`, `testConnection`) are enqueued into
   * `public.edge_jobs` and awaited via Realtime; the loopback HTTP path
   * is used only as a fallback for local development and same-LAN calls.
   *
   * Callers are typically the hardware settings page and the POS runtime,
   * which have both the authenticated Supabase client and the active
   * workstation identity in hand.
   */
  enableRelay(supabase: SupabaseClient, config: RelayConfig): void {
    this._relay = new RelayTransport(supabase, config);
    this._relayConfig = config;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify(config));
      }
    } catch { /* ignore */ }
  }

  disableRelay(): void {
    this._relay = null;
    this._relayConfig = null;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(RELAY_STORAGE_KEY);
      }
    } catch { /* ignore */ }
  }

  isRelayEnabled(): boolean {
    return this._relay !== null;
  }

  getRelayConfig(): RelayConfig | null {
    return this._relayConfig;
  }


  private _authHeaders(): Record<string, string> {
    return this._token ? { Authorization: `Bearer ${this._token}` } : {};
  }

  /**
   * Headers for mutating requests (`/print`, `/test`, `/usb/print`).
   * AccrualFlow Edge Phase 1 requires a fresh single-use `X-Edge-Nonce`
   * to defeat replay of a captured request. Falls back to a timestamp+
   * random string on runtimes without `crypto.randomUUID`.
   */
  private _mutatingHeaders(): Record<string, string> {
    const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
    const nonce = cryptoObj?.randomUUID
      ? cryptoObj.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return {
      'Content-Type': 'application/json',
      'X-Edge-Nonce': nonce,
      ...this._authHeaders(),
    };
  }


  /** Parse JSON body even when res.ok is false — agent errors carry useful detail. */
  private async _readJson<T>(res: Response): Promise<T | null> {
    try {
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════
  //  Configuration
  // ═══════════════════════════════════════════

  /** Get the current agent URL */
  getBaseUrl(): string {
    return this._baseUrl;
  }

  /** Change the agent URL (e.g. for non-default port or LAN agent). Persisted. */
  setBaseUrl(url: string): void {
    this._baseUrl = url;
    this._status = null;
    this._lastProbeTime = 0;
    this._lastAvailable = false;
    this._lastAuthorized = false;
    try {
      if (typeof localStorage !== 'undefined') {
        if (url) localStorage.setItem(URL_STORAGE_KEY, url);
        else localStorage.removeItem(URL_STORAGE_KEY);
      }
    } catch { /* ignore */ }
  }

  // ═══════════════════════════════════════════
  //  Lifecycle (probe loop)
  // ═══════════════════════════════════════════

  /**
   * Reference-counted probe lifecycle. Each owner (e.g. an active hardware
   * settings tab) calls `start()` once and `stop()` once. The probe loop
   * runs ONLY while at least one owner is active. This prevents one
   * component unmount from killing probing for another live owner, and
   * prevents inactive surfaces from spawning a probe loop on mount.
   *
   * On consecutive failures (e.g. `localhost:8043` not running) we apply
   * exponential backoff up to MAX_PROBE_INTERVAL_MS so the browser does
   * not flood the console with ERR_CONNECTION_REFUSED.
   */
  start(intervalMs = 30_000): void {
    this._baseIntervalMs = Math.max(MIN_PROBE_INTERVAL_MS, intervalMs);
    this._startRefs += 1;
    if (this._startRefs > 1) return; // another owner already running the loop
    this._nextDelayMs = this._baseIntervalMs;
    void this.probe();
    this._scheduleNext();
  }

  /** Decrement ref count; only actually stops when the last owner leaves. */
  stop(): void {
    if (this._startRefs > 0) this._startRefs -= 1;
    if (this._startRefs > 0) return;
    if (this._probeTimer) {
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
    }
  }

  private _scheduleNext(): void {
    if (this._probeTimer) clearTimeout(this._probeTimer);
    if (this._startRefs <= 0) return;
    this._probeTimer = setTimeout(() => {
      void this.probe().finally(() => this._scheduleNext());
    }, this._nextDelayMs);
  }

  /** Subscribe to availability changes */
  onChange(callback: AgentChangeCallback): () => void {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  // ═══════════════════════════════════════════
  //  Status & availability
  // ═══════════════════════════════════════════

  /** Is the agent currently available? (cached, no I/O) */
  isAvailable(): boolean {
    return this._lastAvailable;
  }

  /** Get cached agent version */
  getVersion(): string | null {
    return this._status?.version ?? null;
  }

  /** Get devices reported by the agent */
  getDevices(): AgentDeviceInfo[] {
    return this._status?.devices ?? [];
  }

  /** Get full cached status */
  getStatus(): AgentStatusResponse | null {
    return this._status;
  }

  /** Force a probe right now. Updates backoff on success/failure. */
  async probe(): Promise<AgentStatusResponse | null> {
    if (this._probing) return this._status;
    this._probing = true;

    try {
      const status = await this._fetchStatus(true);
      const available = status?.running === true;
      this._status = status;

      // Confirm protected endpoints accept the configured token (or that auth is disabled).
      this._lastAuthorized = available ? await this._checkAuthorized() : false;

      if (available) {
        this._consecutiveFailures = 0;
        this._nextDelayMs = this._baseIntervalMs;
      } else {
        this._consecutiveFailures += 1;
        // Exponential backoff: base * 2^(failures-1), capped. After ~6
        // failures we're at the cap and probing happens only every 5 min.
        const factor = Math.min(2 ** Math.max(0, this._consecutiveFailures - 1), 64);
        this._nextDelayMs = Math.min(MAX_PROBE_INTERVAL_MS, this._baseIntervalMs * factor);
      }

      if (available !== this._lastAvailable) {
        this._lastAvailable = available;
        for (const cb of this._listeners) {
          try { cb(available, status); } catch { /* ignore listener errors */ }
        }
      }

      return status;
    } finally {
      this._probing = false;
    }
  }

  // ═══════════════════════════════════════════
  //  Network printer operations
  // ═══════════════════════════════════════════

  /** Send raw bytes to a network printer via the agent (serialized per endpoint). */
  async printNetwork(
    ipAddress: string,
    port: number,
    data: number[],
  ): Promise<AgentPrintResponse> {
    return this._withEndpointLock(this._netKey(ipAddress, port), async () => {
      // Phase 2: prefer relay when configured. On any relay failure (timeout,
      // insert error, agent not consuming) fall through to the loopback path
      // so LAN / dev workflows keep working.
      if (this._relay) {
        const idem = `print:${this._netKey(ipAddress, port)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const r = await this._relay.dispatch<AgentPrintResponse>({
          role: 'print',
          payload: { ipAddress, port, data },
          idempotencyKey: idem,
        });
        if (r.status === 'done' && r.result) return r.result;
        if (r.status === 'error' && r.result) return r.result;
        // fall through to loopback
      }
      try {
        const res = await fetch(`${this._baseUrl}/print`, {
          method: 'POST',
          headers: this._mutatingHeaders(),
          body: JSON.stringify({ ipAddress, port, data }),
        });
        const body = await this._readJson<AgentPrintResponse & { error?: string }>(res);
        if (res.status === 401) {
          return { success: false, error: 'Agent rejected request: missing or invalid token. Paste the agent token in Hardware settings, or run the agent with AGENT_AUTH_DISABLED=1.' };
        }
        if (body && typeof body.success === 'boolean') return body;
        if (!res.ok) return { success: false, error: `Agent ${res.status}${body?.error ? `: ${body.error}` : ''}` };
        return { success: false, error: 'Agent returned an empty response' };
      } catch {
        return { success: false, error: `Local agent unreachable at ${this._baseUrl}. Cannot print to ${ipAddress}:${port}.` };
      }
    });
  }

  /** Test TCP connection to a network printer via the agent (serialized per endpoint). */
  async testConnection(
    ipAddress: string,
    port: number,
  ): Promise<AgentTestResponse> {
    return this._withEndpointLock(this._netKey(ipAddress, port), async () => {
      if (this._relay) {
        const r = await this._relay.dispatch<AgentTestResponse>({
          role: 'test',
          payload: { ipAddress, port, timeout: 5000 },
        });
        if (r.status === 'done' && r.result) return r.result;
        if (r.status === 'error' && r.result) return r.result;
      }
      try {
        const res = await fetch(`${this._baseUrl}/test`, {
          method: 'POST',
          headers: this._mutatingHeaders(),
          body: JSON.stringify({ ipAddress, port, timeout: 5000 }),
        });
        const body = await this._readJson<AgentTestResponse & { error?: string }>(res);
        if (res.status === 401) {
          return { success: false, error: 'Agent rejected request: missing or invalid token. Paste the agent token in Hardware settings, or run the agent with AGENT_AUTH_DISABLED=1.' };
        }
        if (body && typeof body.success === 'boolean') return body;
        if (!res.ok) return { success: false, error: `Agent ${res.status}${body?.error ? `: ${body.error}` : ''}` };
        return { success: false, error: 'Agent returned an empty response' };
      } catch {
        return {
          success: false,
          error: `Local agent unreachable at ${this._baseUrl}. Is the print agent running?`,
        };
      }
    });
  }

  // ═══════════════════════════════════════════
  //  USB printer operations
  // ═══════════════════════════════════════════

  /** Print to a USB printer via the agent (serialized per endpoint). */
  async printUsb(
    vendorId: number,
    productId: number,
    data: number[],
  ): Promise<AgentPrintResponse> {
    return this._withEndpointLock(this._usbKey(vendorId, productId), async () => {
      if (this._relay) {
        const idem = `usb_print:${this._usbKey(vendorId, productId)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const r = await this._relay.dispatch<AgentPrintResponse>({
          role: 'usb_print',
          payload: { vendorId, productId, data },
          idempotencyKey: idem,
        });
        if (r.status === 'done' && r.result) return r.result;
        if (r.status === 'error' && r.result) return r.result;
      }
      try {
        const res = await fetch(`${this._baseUrl}/usb/print`, {
          method: 'POST',
          headers: this._mutatingHeaders(),
          body: JSON.stringify({ vendorId, productId, data }),
        });
        const body = await this._readJson<AgentPrintResponse & { error?: string }>(res);
        if (res.status === 401) return { success: false, error: 'Agent rejected request: missing or invalid token.' };
        if (body && typeof body.success === 'boolean') return body;
        if (!res.ok) return { success: false, error: `Agent ${res.status}${body?.error ? `: ${body.error}` : ''}` };
        return { success: false, error: 'Agent returned an empty response' };
      } catch {
        return { success: false, error: 'Local agent unreachable for USB printing.' };
      }
    });
  }

  /** List USB devices connected to the agent host */
  async listUsbDevices(): Promise<AgentUsbDevicesResponse> {
    try {
      const res = await fetch(`${this._baseUrl}/usb/devices`, { headers: this._authHeaders() });
      if (!res.ok) return { devices: [] };
      return await res.json();
    } catch {
      return { devices: [] };
    }
  }

  // ═══════════════════════════════════════════
  //  Device discovery
  // ═══════════════════════════════════════════

  /** Discover devices on the local network via the agent */
  async discoverDevices(): Promise<AgentDiscoverResponse> {
    try {
      const res = await fetch(`${this._baseUrl}/discover?subnet=auto`, { headers: this._authHeaders() });
      if (!res.ok) return { devices: [] };
      return await res.json();
    } catch {
      return { devices: [] };
    }
  }

  // ═══════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════

  /** Probe a protected endpoint to confirm the token is accepted. */
  private async _checkAuthorized(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      // Cheap protected GET — devices list returns quickly even with 0 devices.
      const res = await fetch(`${this._baseUrl}/usb/devices`, {
        headers: this._authHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.status !== 401;
    } catch {
      return false;
    }
  }

  private async _fetchStatus(forceRefresh = false): Promise<AgentStatusResponse | null> {
    const now = Date.now();
    if (!forceRefresh && this._status && now - this._lastProbeTime < 10_000) {
      return this._status;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

      const res = await fetch(`${this._baseUrl}/status`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this._status = null;
        return null;
      }

      const data: AgentStatusResponse = await res.json();
      this._status = data;
      this._lastProbeTime = now;
      return data;
    } catch {
      this._status = null;
      return null;
    }
  }
}

/**
 * Singleton local-agent client. Service-internal — UI code MUST go through
 * `hardwareClient.agent.*`. The no-legacy-hardware-shell guard test
 * enforces this rule.
 */
export const agentClient = new AgentClientImpl();
