import { describe, it, expect, vi } from 'vitest';
import {
  BluetoothPairingManager, BT_BACKOFF_MS, canBtTransition, nextBackoff,
  InMemoryBtPairingsStore, type BluetoothRadio,
} from '../../../electron/hardware/bluetooth';

// Use base64 so the "ciphertext does not contain plaintext" assertion is
// a real check. Production `KeyManager` uses AES-256-GCM.
const fakeKm = {
  encrypt: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
  decrypt: (c: string) => Buffer.from(c, 'base64').toString('utf8'),
};

function makeRadio(over: Partial<BluetoothRadio> = {}): BluetoothRadio {
  return {
    available: async () => true,
    pair: async () => ({ ok: true, linkKey: 'lk-xyz' }),
    unpair: async () => undefined,
    connect: async () => ({ ok: true }),
    disconnect: async () => undefined,
    ping: async () => ({ ok: true, latencyMs: 5 }),
    ...over,
  };
}

describe('Bluetooth FSM (Track B)', () => {
  it('backoff sequence is 1s, 2s, 4s, 8s, 16s, capped at 30s', () => {
    expect(BT_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(nextBackoff(1)).toBe(1_000);
    expect(nextBackoff(6)).toBe(30_000);
    expect(nextBackoff(100)).toBe(30_000);
  });

  it('rejects transitions that violate the table', () => {
    expect(canBtTransition('disconnected', 'connecting')).toBe(true);
    expect(canBtTransition('connected', 'pairing')).toBe(false);
    expect(canBtTransition('connected', 'reconnecting')).toBe(true);
  });

  it('pair → connect happy path lands in connected', async () => {
    const store = new InMemoryBtPairingsStore(fakeKm);
    const mgr = new BluetoothPairingManager({ radio: makeRadio(), store });
    const p = await mgr.pair({ deviceId: 'bt-1', mac: 'aa:bb', role: 'receipt_printer' });
    expect(p.ok).toBe(true);
    const c = await mgr.connect('bt-1');
    expect(c.ok).toBe(true);
    expect(mgr.getState('bt-1')).toBe('connected');
  });

  it('schedules reconnect with backoff on connect failure', async () => {
    const store = new InMemoryBtPairingsStore(fakeKm);
    await new BluetoothPairingManager({ radio: makeRadio(), store }).pair({ deviceId: 'bt-2', mac: 'a', role: 'receipt_printer' });
    const schedule = vi.fn();
    const mgr = new BluetoothPairingManager({
      radio: makeRadio({ connect: async () => ({ ok: false, error: 'oops' }) }),
      store, schedule,
    });
    await mgr.connect('bt-2');
    expect(mgr.getState('bt-2')).toBe('reconnecting');
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBe(1_000);
  });

  it('reports radio unavailable cleanly', async () => {
    const store = new InMemoryBtPairingsStore(fakeKm);
    const mgr = new BluetoothPairingManager({ radio: makeRadio({ available: async () => false }), store });
    const p = await mgr.pair({ deviceId: 'bt-3', mac: 'x', role: 'receipt_printer' });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/unavailable/);
  });
});

describe('BtPairingsStore — link keys are encrypted on the wire', () => {
  it('ciphertext snapshot never matches the plaintext link key', () => {
    const store = new InMemoryBtPairingsStore(fakeKm);
    store.upsert({
      device_id: 'bt-9', mac: 'aa', name: null, role: 'receipt_printer',
      link_key_plain: 'super-secret', auto_reconnect: 1, paired_at: 1, last_connected_at: null,
    });
    const cipher = store._ciphertextFor('bt-9');
    expect(cipher).toBe(Buffer.from('super-secret', 'utf8').toString('base64'));
    expect(cipher).not.toContain('super-secret');
  });
});