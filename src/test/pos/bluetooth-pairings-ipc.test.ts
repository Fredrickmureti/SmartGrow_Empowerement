/**
 * Track B-UI — Bluetooth pairing IPC helpers.
 *
 * Exercises `electron/hardware/bluetooth/ipc.ts` against a real
 * `BluetoothPairingManager` + `InMemoryBtPairingsStore` + fake radio.
 * The handlers are pure functions, so no `ipcMain` harness is needed.
 *
 * Invariants under test:
 *   - `list` never leaks `link_key_plain` (the safety projection holds).
 *   - `unpair` tears down the radio side AND clears the store row.
 *   - `connect` / `disconnect` round-trip cleanly.
 *   - `list` after `unpair` no longer contains the device.
 *   - Missing manager surfaces a clean `{ ok: false, error }` instead of throwing.
 */

import { describe, it, expect } from 'vitest';
import {
  BluetoothPairingManager,
  InMemoryBtPairingsStore,
  ipcList, ipcPair, ipcUnpair, ipcConnect, ipcDisconnect,
  type BluetoothRadio,
} from '../../../electron/hardware/bluetooth';

function makeRadio(): BluetoothRadio & { unpaired: string[]; disconnected: string[] } {
  const unpaired: string[] = [];
  const disconnected: string[] = [];
  return {
    available: async () => true,
    pair: async (_mac: string) => ({ ok: true, linkKey: 'super-secret-link-key' }),
    unpair: async (mac: string) => { unpaired.push(mac); },
    connect: async (_mac: string) => ({ ok: true }),
    disconnect: async (mac: string) => { disconnected.push(mac); },
    ping: async () => ({ ok: true, latencyMs: 1 }),
    unpaired,
    disconnected,
  };
}

function setup() {
  const km = { encrypt: (s: string) => Buffer.from(s).toString('base64'), decrypt: (c: string) => Buffer.from(c, 'base64').toString() };
  const store = new InMemoryBtPairingsStore(km);
  const radio = makeRadio();
  const manager = new BluetoothPairingManager({ radio, store, broker: { publish: (_e: unknown) => {} } });
  return { store, radio, manager, get: () => manager };
}

describe('Track B-UI — bluetooth IPC helpers', () => {
  it('missing manager returns a clean error envelope', async () => {
    const r = await ipcList(() => null);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/not initialised/);
  });

  it('pair → list returns the row WITHOUT link_key_plain', async () => {
    const { get } = setup();
    const p = await ipcPair(get, {
      deviceId: 'dev-1', mac: '00:11:22:33:44:55', name: 'Star Printer', role: 'receipt_printer',
    });
    expect(p.ok).toBe(true);

    const l = await ipcList(get);
    expect(l.ok).toBe(true);
    if (!l.ok) throw new Error('expected list ok');
    expect(l.data).toHaveLength(1);
    const row = l.data![0]!;
    expect(row.device_id).toBe('dev-1');
    expect(row.mac).toBe('00:11:22:33:44:55');
    expect(row.name).toBe('Star Printer');
    expect(row.role).toBe('receipt_printer');
    // SECURITY — plaintext link key MUST NOT cross the IPC boundary.
    expect(JSON.stringify(row)).not.toContain('super-secret-link-key');
    const bag = row as unknown as Record<string, unknown>;
    expect(bag.link_key_plain).toBeUndefined();
    expect(bag.link_key_encrypted).toBeUndefined();
    expect(row.state).toBeDefined();
  });

  it('unpair tears down the radio AND clears the store', async () => {
    const { get, radio, store } = setup();
    await ipcPair(get, { deviceId: 'dev-2', mac: 'AA:BB:CC:DD:EE:FF', role: 'cash_drawer' });
    expect(store.list()).toHaveLength(1);

    const u = await ipcUnpair(get, 'dev-2');
    expect(u.ok).toBe(true);
    expect(radio.unpaired).toEqual(['AA:BB:CC:DD:EE:FF']);
    expect(store.list()).toHaveLength(0);

    const l = await ipcList(get);
    expect(l.ok && l.data).toEqual([]);
  });

  it('connect then disconnect round-trips through the radio', async () => {
    const { get, radio } = setup();
    await ipcPair(get, { deviceId: 'dev-3', mac: '11:22:33:44:55:66', role: 'scale' });

    const c = await ipcConnect(get, 'dev-3');
    expect(c.ok).toBe(true);

    const d = await ipcDisconnect(get, 'dev-3');
    expect(d.ok).toBe(true);
    expect(radio.disconnected).toEqual(['11:22:33:44:55:66']);
  });

  it('validates required fields on pair', async () => {
    const { get } = setup();
    const r = await ipcPair(get, { deviceId: '', mac: '', role: 'receipt_printer' });
    expect(r.ok).toBe(false);
  });

  it('validates deviceId on unpair / connect / disconnect', async () => {
    const { get } = setup();
    expect((await ipcUnpair(get, '')).ok).toBe(false);
    expect((await ipcConnect(get, '')).ok).toBe(false);
    expect((await ipcDisconnect(get, '')).ok).toBe(false);
  });
});
