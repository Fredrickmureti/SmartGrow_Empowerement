/**
 * ConnectivityManager
 *
 * Single source of truth for connectivity state across the app.
 * Unifies three signals:
 *   1. `navigator.onLine` (browser + PWA + Electron renderer)
 *   2. Electron main-process net status via `window.pos.network` IPC
 *   3. A lazy HEAD ping to Supabase used to recover from
 *      "navigator says online but the network actually dropped".
 *
 * Exposes three states:
 *   - `online`    — verified reachable
 *   - `degraded`  — `navigator.onLine` true but last probe failed
 *   - `offline`   — `navigator.onLine` false OR Electron reports offline
 *
 * Use `getStatus()` for an imperative read and `subscribe()` for a
 * push-style stream. Transitions are de-duplicated so subscribers never
 * receive the same state twice in a row.
 */

export type ConnectivityStatus = "online" | "degraded" | "offline";
export type RealtimeState = "subscribed" | "channel_error" | "timed_out" | "closed" | "unknown";

type Listener = (status: ConnectivityStatus) => void;
type RealtimeListener = (state: RealtimeState) => void;

const PROBE_TIMEOUT_MS = 4_000;
const MIN_PROBE_INTERVAL_MS = 5_000;

class ConnectivityManagerImpl {
  private status: ConnectivityStatus = "online";
  private realtime: RealtimeState = "unknown";
  private realtimeDegradedSince: number | null = null;
  private listeners = new Set<Listener>();
  private realtimeListeners = new Set<RealtimeListener>();
  private initialized = false;
  private lastProbeAt = 0;
  private inflightProbe: Promise<boolean> | null = null;
  private probeUrl: string | null = null;
  private lastOnlineAt: number | null = Date.now();
  private posReattachTimer: ReturnType<typeof setInterval> | null = null;

  init() {
    if (this.initialized || typeof window === "undefined") return;
    this.initialized = true;

    // Browser online/offline events.
    this.status = navigator.onLine ? "online" : "offline";
    if (this.status === "online") this.lastOnlineAt = Date.now();
    window.addEventListener("online", () => {
      this.set("online");
      this.probe();
    });
    window.addEventListener("offline", () => this.set("offline"));

    this.attachElectronNetwork();
    // Electron preload can resolve after renderer mount. Poll for up to
    // 3 s so the OS-level signal is never permanently lost on a race.
    if (!this.isElectronNetworkAttached()) {
      let tries = 0;
      this.posReattachTimer = setInterval(() => {
        tries += 1;
        if (this.attachElectronNetwork() || tries >= 6) {
          if (this.posReattachTimer) {
            clearInterval(this.posReattachTimer);
            this.posReattachTimer = null;
          }
        }
      }, 500);
    }
  }

  private isElectronNetworkAttached(): boolean {
    const pos = (window as unknown as { pos?: { network?: unknown } }).pos;
    return !!pos?.network;
  }

  private electronAttached = false;
  private attachElectronNetwork(): boolean {
    if (this.electronAttached) return true;
    if (typeof window === "undefined") return false;
    const pos = (window as unknown as { pos?: { network?: { getStatus?: () => Promise<boolean>; onStatusChange?: (cb: (online: boolean) => void) => void } } }).pos;
    if (!pos?.network?.onStatusChange) return false;
    try {
      pos.network.onStatusChange((online: boolean) => {
        this.set(online ? "online" : "offline");
      });
      if (pos.network.getStatus) {
        pos.network.getStatus().then((online) => {
          this.set(online ? "online" : "offline");
        }).catch(() => { /* keep current */ });
      }
      this.electronAttached = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Timestamp of the most recent verified-online moment, or null. */
  getLastOnlineAt(): number | null {
    return this.lastOnlineAt;
  }

  /** Configure the URL used for active connectivity probes. */
  setProbeUrl(url: string) {
    this.probeUrl = url;
  }

  getStatus(): ConnectivityStatus {
    if (!this.initialized) this.init();
    return this.status;
  }

  isOnline(): boolean {
    return this.getStatus() === "online";
  }

  subscribe(listener: Listener): () => void {
    if (!this.initialized) this.init();
    this.listeners.add(listener);
    // Fire-once with current state so consumers can render immediately.
    try { listener(this.status); } catch { /* listener bug, not ours */ }
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Mark the last network attempt as failed/succeeded. Hooks/wrappers
   * call this so we can flip into `degraded` even when navigator
   * insists we're online (captive portals, WiFi without internet).
   */
  reportFailure() {
    if (!this.initialized) this.init();
    if (this.status === "online") this.set("degraded");
  }

  reportSuccess() {
    if (!this.initialized) this.init();
    if (this.status !== "offline") this.set("online");
  }

  /**
   * Fire a small probe to confirm whether the server is actually
   * reachable. Rate-limited; safe to call repeatedly.
   *
   * Uses a CORS-eligible GET against Supabase's auth health endpoint so
   * we can distinguish a real 2xx from a network-level failure. Opaque
   * `no-cors` responses always succeed and would defeat the check.
   */
  async probe(): Promise<boolean> {
    if (!this.probeUrl) return this.status !== "offline";
    if (this.inflightProbe) return this.inflightProbe;
    const now = Date.now();
    if (now - this.lastProbeAt < MIN_PROBE_INTERVAL_MS) {
      return this.status !== "offline";
    }
    this.lastProbeAt = now;

    this.inflightProbe = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        const res = await fetch(this.probeUrl!, { method: "GET", signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timer);
        // Any non-network response — even 4xx/5xx — proves the server is
        // reachable. Only network errors / timeouts indicate offline.
        if (res.status > 0) {
          this.reportSuccess();
          return true;
        }
        this.reportFailure();
        return false;
      } catch {
        this.reportFailure();
        return false;
      } finally {
        this.inflightProbe = null;
      }
    })();

    return this.inflightProbe;
  }

  // ───────────────── Realtime sub-state ─────────────────

  reportRealtimeState(state: RealtimeState) {
    if (state === this.realtime) return;
    this.realtime = state;
    if (state === "channel_error" || state === "timed_out" || state === "closed") {
      if (this.realtimeDegradedSince === null) this.realtimeDegradedSince = Date.now();
    } else if (state === "subscribed") {
      this.realtimeDegradedSince = null;
    }
    for (const l of this.realtimeListeners) {
      try { l(state); } catch { /* swallow */ }
    }
  }

  getRealtimeState(): RealtimeState {
    return this.realtime;
  }

  /**
   * True when realtime has been in a non-subscribed state long enough
   * to surface. `closed`/`channel_error`/`timed_out` all share the
   * same grace window — short blips never flicker the UI.
   */
  isRealtimeDegraded(graceMs = 5_000): boolean {
    if (this.realtime === "subscribed" || this.realtime === "unknown") return false;
    if (this.realtimeDegradedSince === null) {
      // Stamp lazily so the grace window applies symmetrically.
      this.realtimeDegradedSince = Date.now();
      return false;
    }
    return Date.now() - this.realtimeDegradedSince >= graceMs;
  }

  subscribeRealtime(listener: RealtimeListener): () => void {
    this.realtimeListeners.add(listener);
    try { listener(this.realtime); } catch { /* swallow */ }
    return () => { this.realtimeListeners.delete(listener); };
  }

  /** Test-only: reset internal state. */
  _resetForTests() {
    this.status = "online";
    this.realtime = "unknown";
    this.realtimeDegradedSince = null;
    this.listeners.clear();
    this.realtimeListeners.clear();
    this.initialized = false;
    this.lastProbeAt = 0;
    this.inflightProbe = null;
    this.lastOnlineAt = Date.now();
    this.electronAttached = false;
    if (this.posReattachTimer) { clearInterval(this.posReattachTimer); this.posReattachTimer = null; }
  }

  private set(next: ConnectivityStatus) {
    if (next === this.status) return;
    this.status = next;
    if (next === "online") {
      this.lastOnlineAt = Date.now();
      // Recovery: collapse any lingering realtime-degraded gate so the
      // muted "Live updates paused…" strip disappears immediately when
      // connectivity returns. It will only reappear if a channel
      // afterwards reports a fresh error past the grace window.
      this.realtimeDegradedSince = null;
      if (this.realtime !== "subscribed") {
        this.realtime = "unknown";
        for (const l of this.realtimeListeners) {
          try { l("unknown"); } catch { /* swallow */ }
        }
      }
    }
    for (const l of this.listeners) {
      try { l(next); } catch { /* swallow */ }
    }
  }
}

export const connectivityManager = new ConnectivityManagerImpl();
export type ConnectivityManager = typeof connectivityManager;