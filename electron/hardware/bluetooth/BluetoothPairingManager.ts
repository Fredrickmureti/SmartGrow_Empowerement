/**
 * BluetoothPairingManager — vendor-agnostic FSM + reconnect orchestrator.
 *
 * State machine:
 *   disconnected → discovering → pairing → paired
 *                                ↓
 *                              error / disconnected
 *   paired → connecting → connected
 *                   ↓
 *               reconnecting (with exponential backoff)
 *   reconnecting → connecting → connected | reconnecting (next attempt)
 *
 * The actual radio interaction is delegated to a {@link BluetoothRadio}
 * adapter so tests can drive deterministic outcomes; production wires the
 * adapter to `noble` lazily inside `BluetoothTransport`. Persistent state
 * (pairing keys, auto_reconnect flag) lives in the {@link BtPairingsStore}.
 *
 * Backoff schedule: 1s, 2s, 4s, 8s, 16s, capped at 30s. Resets to 1s on
 * any successful connection. Matches `noble` community best practice
 * and Zebra's TC52 reconnect window.
 */

import type { BtPairingsStore, BtPairingRow } from './BtPairingsStore';
import type { EventBroker } from '../EventBroker';
import type { DeviceRole } from '../types';

export type BtState =
  | 'disconnected'
  | 'discovering'
  | 'pairing'
  | 'paired'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

const VALID: Record<BtState, readonly BtState[]> = {
  disconnected: ['discovering', 'connecting', 'error'],
  discovering: ['pairing', 'disconnected', 'error'],
  pairing: ['paired', 'error', 'disconnected'],
  paired: ['connecting', 'disconnected'],
  connecting: ['connected', 'reconnecting', 'error', 'disconnected'],
  connected: ['disconnected', 'reconnecting', 'error'],
  reconnecting: ['connecting', 'disconnected', 'error'],
  error: ['disconnected', 'connecting'],
};

export function canBtTransition(from: BtState, to: BtState): boolean {
  return VALID[from]?.includes(to) ?? false;
}

/** Backoff sequence (ms). Capped at the last element. */
export const BT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export function nextBackoff(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1) - 1, BT_BACKOFF_MS.length - 1);
  return BT_BACKOFF_MS[idx];
}

export interface BluetoothRadio {
  /** True if a Bluetooth adapter is available. */
  available(): Promise<boolean>;
  /** Initiate pairing — returns an opaque link key the OS can persist. */
  pair(mac: string): Promise<{ ok: boolean; linkKey?: string; error?: string }>;
  unpair(mac: string): Promise<void>;
  connect(mac: string, linkKey?: string): Promise<{ ok: boolean; error?: string }>;
  disconnect(mac: string): Promise<void>;
  ping(mac: string): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

export interface PairOptions {
  deviceId: string;
  mac: string;
  name?: string;
  role: DeviceRole;
  autoReconnect?: boolean;
}

export interface BtHealth { ok: boolean; latencyMs: number; error?: string; state: BtState }

export interface BtManagerOptions {
  radio: BluetoothRadio;
  store: BtPairingsStore;
  broker?: Pick<EventBroker, 'publish'>;
  now?: () => number;
  /** Test seam — wraps `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown;
}

export class BluetoothPairingManager {
  private states = new Map<string, BtState>();
  private attempts = new Map<string, number>();
  private readonly opts: BtManagerOptions;

  constructor(opts: BtManagerOptions) {
    this.opts = opts;
  }

  getState(deviceId: string): BtState {
    return this.states.get(deviceId) ?? 'disconnected';
  }

  listPaired(): BtPairingRow[] { return this.opts.store.list(); }

  /** Reconnect every auto_reconnect=1 device. Call once on app.ready. */
  async bootstrap(): Promise<void> {
    if (!(await this.opts.radio.available())) return;
    for (const row of this.opts.store.list()) {
      if (row.auto_reconnect !== 1) continue;
      void this.connect(row.device_id).catch(() => { /* manager already scheduled retry */ });
    }
  }

  async pair(opts: PairOptions): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.opts.radio.available())) {
      return { ok: false, error: 'bluetooth radio unavailable' };
    }
    this.transition(opts.deviceId, 'discovering', 'user initiated pair');
    this.transition(opts.deviceId, 'pairing');
    const r = await this.opts.radio.pair(opts.mac);
    if (!r.ok) {
      this.transition(opts.deviceId, 'error', r.error);
      return { ok: false, error: r.error };
    }
    this.opts.store.upsert({
      device_id: opts.deviceId,
      mac: opts.mac,
      name: opts.name ?? null,
      role: opts.role,
      link_key_plain: r.linkKey ?? null,
      auto_reconnect: opts.autoReconnect === false ? 0 : 1,
      paired_at: (this.opts.now ?? Date.now)(),
      last_connected_at: null,
    });
    this.transition(opts.deviceId, 'paired');
    return { ok: true };
  }

  async unpair(deviceId: string): Promise<void> {
    const row = this.opts.store.get(deviceId);
    if (row) await this.opts.radio.unpair(row.mac);
    this.opts.store.delete(deviceId);
    this.states.delete(deviceId);
    this.attempts.delete(deviceId);
    this.publish(deviceId, 'disconnected', 'unpaired');
  }

  async connect(deviceId: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.opts.store.get(deviceId);
    if (!row) return { ok: false, error: 'device not paired' };
    if (!(await this.opts.radio.available())) {
      this.transition(deviceId, 'error', 'radio unavailable');
      return { ok: false, error: 'radio unavailable' };
    }
    this.transition(deviceId, 'connecting');
    const linkKey = row.link_key_plain ?? undefined;
    const r = await this.opts.radio.connect(row.mac, linkKey);
    if (r.ok) {
      this.attempts.set(deviceId, 0);
      this.opts.store.markConnected(deviceId, (this.opts.now ?? Date.now)());
      this.transition(deviceId, 'connected');
      return { ok: true };
    }
    this.scheduleReconnect(deviceId, r.error);
    return { ok: false, error: r.error };
  }

  async disconnect(deviceId: string): Promise<void> {
    const row = this.opts.store.get(deviceId);
    if (row) await this.opts.radio.disconnect(row.mac);
    this.attempts.set(deviceId, 0);
    this.transition(deviceId, 'disconnected', 'manual');
  }

  async healthCheck(deviceId: string): Promise<BtHealth> {
    const row = this.opts.store.get(deviceId);
    if (!row) return { ok: false, latencyMs: 0, error: 'not paired', state: 'disconnected' };
    if (!(await this.opts.radio.available())) {
      return { ok: false, latencyMs: 0, error: 'radio unavailable', state: this.getState(deviceId) };
    }
    const r = await this.opts.radio.ping(row.mac);
    const state = this.getState(deviceId);
    return { ...r, state };
  }

  private scheduleReconnect(deviceId: string, reason?: string): void {
    const attempt = (this.attempts.get(deviceId) ?? 0) + 1;
    this.attempts.set(deviceId, attempt);
    const delay = nextBackoff(attempt);
    this.transition(deviceId, 'reconnecting', `${reason ?? 'connect failed'} (attempt ${attempt}, retry in ${delay}ms)`);
    const schedule = this.opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    schedule(() => { void this.connect(deviceId); }, delay);
  }

  private transition(deviceId: string, to: BtState, reason?: string): void {
    const from = this.getState(deviceId);
    if (from === to) return;
    if (!canBtTransition(from, to)) {
      // Force disconnected → recovery path rather than throwing.
      this.states.set(deviceId, 'error');
      this.publish(deviceId, 'error', `invalid transition ${from}→${to}`);
      return;
    }
    this.states.set(deviceId, to);
    this.publish(deviceId, to, reason);
  }

  private publish(deviceId: string, state: BtState, reason?: string): void {
    try {
      this.opts.broker?.publish({
        type: 'bluetooth:state',
        ts: (this.opts.now ?? Date.now)(),
        data: { deviceId, state, reason },
      });
    } catch { /* swallow */ }
  }
}