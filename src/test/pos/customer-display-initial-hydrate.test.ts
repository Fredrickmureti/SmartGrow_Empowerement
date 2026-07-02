/**
 * Verifies the browser-popup path of CustomerDisplayClient:
 *  - opens a popup, then broadcasts an initial idle payload so the
 *    popup paints immediately instead of staying blank;
 *  - caches `update()` payloads and replays them on a
 *    `customer-display-request-state` ping (popup reload recovery).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { customerDisplayClient } from '@/services/hardware/local-display/CustomerDisplayClient';

class FakeBC {
  static channels = new Map<string, FakeBC[]>();
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(public name: string) {
    const list = FakeBC.channels.get(name) ?? [];
    list.push(this);
    FakeBC.channels.set(name, list);
  }
  postMessage(data: unknown) {
    const list = FakeBC.channels.get(this.name) ?? [];
    for (const ch of list) {
      if (ch === this) continue;
      ch.onmessage?.({ data } as MessageEvent);
    }
  }
  close() {
    const list = FakeBC.channels.get(this.name) ?? [];
    FakeBC.channels.set(this.name, list.filter((c) => c !== this));
  }
}

describe('CustomerDisplayClient — browser popup hydration', () => {
  beforeEach(() => {
    FakeBC.channels.clear();
    (globalThis as unknown as { BroadcastChannel: typeof FakeBC }).BroadcastChannel = FakeBC;
    // Drop the singleton's stale listener and reset lastPayload to the
    // default idle frame so each test exercises the seeded-state path.
    (customerDisplayClient as unknown as { requestStateBc: unknown }).requestStateBc = null;
    (customerDisplayClient as unknown as { lastPayload: unknown }).lastPayload = {
      status: 'idle', items: [], subtotal: 0, tax: 0, discount: 0, total: 0,
    };
    vi.useFakeTimers();
  });

  it('replies to a popup request-state ping with the seeded idle payload before any update()', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, close: () => {}, postMessage: () => {} } as unknown as Window);

    const res = await customerDisplayClient.open({ enabled: true });
    expect(res.success).toBe(true);

    // Simulate the popup: subscribe, then ping for state.
    const received: unknown[] = [];
    const popup = new FakeBC('pos:customer-display');
    popup.onmessage = (ev) => received.push(ev.data);
    popup.postMessage({ type: 'customer-display-request-state' });

    const updates = received.filter((d) => (d as { type?: string })?.type === 'customer-display-update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect((updates[0] as { payload: { status: string } }).payload.status).toBe('idle');
  });

  it('replays the most recent update() payload on subsequent request-state pings', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, close: () => {}, postMessage: () => {} } as unknown as Window);

    const res = await customerDisplayClient.open({ enabled: true });
    expect(res.success).toBe(true);

    await customerDisplayClient.update({
      status: 'scanning', items: [], subtotal: 12, tax: 0, discount: 0, total: 12,
    });

    const received: unknown[] = [];
    const popup = new FakeBC('pos:customer-display');
    popup.onmessage = (ev) => received.push(ev.data);
    popup.postMessage({ type: 'customer-display-request-state' });

    const replayed = received.find(
      (d) => (d as { type?: string; payload?: { status?: string } })?.type === 'customer-display-update'
          && (d as { payload?: { status?: string } }).payload?.status === 'scanning',
    );
    expect(replayed).toBeTruthy();
  });
});

