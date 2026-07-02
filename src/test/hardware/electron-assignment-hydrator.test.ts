/**
 * ElectronAssignmentHydrator — unit test.
 *
 * Given a stubbed `window.pos.devices.upsert` and a Supabase select that
 * returns N enabled rows, the hydrator must push each row exactly once
 * and report `rowsHydrated === N` via `getHydratorStatus()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => {
  const rows = [
    { id: 'r1', organization_id: 'org-1', business_id: null, scope_kind: 'register', scope_id: 'reg-1', role: 'receipt_printer', transport: 'electron-native', driver: 'escpos', display_name: 'Front', config: { vid: 1 }, capabilities: {}, enabled: true, is_default: true, status: 'unknown', last_seen_at: null, last_error: null, source_config_id: null, created_at: '', updated_at: '' },
    { id: 'r2', organization_id: 'org-1', business_id: null, scope_kind: 'tenant', scope_id: null, role: 'cash_drawer', transport: 'electron-native', driver: 'escpos', display_name: 'Drawer', config: {}, capabilities: {}, enabled: true, is_default: false, status: 'unknown', last_seen_at: null, last_error: null, source_config_id: null, created_at: '', updated_at: '' },
  ];
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: (resolve: (v: { data: typeof rows; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  };
  return {
    supabase: {
      from: vi.fn(() => builder),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
      })),
      removeChannel: vi.fn(),
    },
  };
});

import {
  startElectronAssignmentHydrator,
  stopElectronAssignmentHydrator,
  getHydratorStatus,
} from '@/services/hardware/ElectronAssignmentHydrator';

describe('ElectronAssignmentHydrator', () => {
  beforeEach(() => {
    stopElectronAssignmentHydrator();
    (window as unknown as { pos?: unknown }).pos = {
      devices: {
        list: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
        upsert: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  });

  afterEach(() => {
    stopElectronAssignmentHydrator();
    delete (window as unknown as { pos?: unknown }).pos;
  });

  it('hydrates each enabled assignment exactly once and reports status', async () => {
    const stop = startElectronAssignmentHydrator('org-1');
    // Let hydrateOnce drain its awaits
    await new Promise((r) => setTimeout(r, 20));

    const upsert = ((window as unknown as { pos: { devices: { upsert: ReturnType<typeof vi.fn> } } }).pos.devices.upsert);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ role: 'receipt_printer', transport: 'electron-native' });
    expect(upsert.mock.calls[1]?.[0]).toMatchObject({ role: 'cash_drawer', terminalId: null });

    const s = getHydratorStatus();
    expect(s.active).toBe(true);
    expect(s.rowsHydrated).toBe(2);
    expect(s.lastSyncAt).not.toBeNull();

    stop();
    expect(getHydratorStatus().active).toBe(false);
  });

  it('is a no-op when window.pos.devices is missing', async () => {
    delete (window as unknown as { pos?: unknown }).pos;
    const stop = startElectronAssignmentHydrator('org-1');
    await new Promise((r) => setTimeout(r, 10));
    expect(getHydratorStatus().active).toBe(false);
    stop();
  });
});