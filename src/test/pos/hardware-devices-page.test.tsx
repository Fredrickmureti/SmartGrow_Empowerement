/**
 * Track 4b.4 — HardwareDevices page contract test.
 *
 * Locks the architectural invariants of the new settings page without
 * coupling to its exact visual layout:
 *
 *  1. With a stubbed `window.pos.devices.list`, every returned assignment
 *     surfaces a `data-testid="assignment-row-<id>"` row.
 *  2. Clicking the per-role "Test" button calls `window.pos.hardware.exec`
 *     exactly once with the correct `role`, `op`, and an `idempotencyKey`
 *     matching `/^hw-test:<role>:/` (operator-test traceability).
 *  3. Clicking "Remove" calls `window.pos.devices.remove(id)` and refetches.
 *  4. With no `window.pos` (browser preview / SSR / vitest jsdom default),
 *     the page renders the "Browser preview" empty state instead of
 *     throwing or attempting any IPC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

interface ExecCall {
  role: string;
  op: string;
  payload?: unknown;
  idempotencyKey: string;
}

interface AssignmentRow {
  id: number;
  terminal_id: string | null;
  role: string;
  transport: string;
  driver: string;
  config_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function row(partial: Partial<AssignmentRow> & Pick<AssignmentRow, 'id' | 'role'>): AssignmentRow {
  return {
    terminal_id: null,
    transport: 'usb',
    driver: 'escpos-generic',
    config_json: '{}',
    enabled: 1,
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

describe('HardwareDevicesPage — chokepoint + idempotency invariants (Track 4b.4)', () => {
  const execCalls: ExecCall[] = [];
  const removeCalls: number[] = [];
  let listImpl: () => Promise<{ ok: boolean; rows?: AssignmentRow[]; error?: string }>;
  let originalPos: unknown;

  beforeEach(() => {
    execCalls.length = 0;
    removeCalls.length = 0;
    listImpl = async () => ({ ok: true, rows: [] });
    originalPos = (globalThis as { pos?: unknown }).pos;
    (globalThis as unknown as { pos: unknown }).pos = {
      hardware: {
        exec: async (cmd: ExecCall) => {
          execCalls.push(cmd);
          return { ok: true, result: { ack: `${cmd.role}:${cmd.op}` } };
        },
        subscribe: () => () => undefined,
      },
      devices: {
        list: () => listImpl(),
        upsert: async () => ({ ok: true }),
        remove: async (id: number) => {
          removeCalls.push(id);
          return { ok: true, removed: true };
        },
        setTerminal: async () => ({ ok: true, terminalId: null }),
      },
      sale: { committed: async () => ({ ok: true }) },
    };
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    (globalThis as { pos?: unknown }).pos = originalPos;
  });

  it('renders one assignment row per record returned by window.pos.devices.list', async () => {
    listImpl = async () => ({
      ok: true,
      rows: [
        row({ id: 11, role: 'receipt_printer', transport: 'cups' }),
        row({ id: 22, role: 'cash_drawer', transport: 'usb' }),
      ],
    });
    const { HardwareDevicesPage } = await import('@/apps/platform/hardware/HardwareDevices');
    render(<HardwareDevicesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('assignment-row-11')).toBeTruthy();
      expect(screen.getByTestId('assignment-row-22')).toBeTruthy();
    });
  });

  it('Test button on receipt_printer dispatches hardwareClient.exec → window.pos.hardware.exec with traceable idempotencyKey', async () => {
    listImpl = async () => ({
      ok: true,
      rows: [row({ id: 1, role: 'receipt_printer' })],
    });
    const { HardwareDevicesPage } = await import('@/apps/platform/hardware/HardwareDevices');
    render(<HardwareDevicesPage />);
    const btn = await screen.findByTestId('test-receipt_printer');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(execCalls).toHaveLength(1);
    });
    const call = execCalls[0];
    expect(call.role).toBe('receipt_printer');
    expect(call.op).toBe('print_receipt');
    expect(call.idempotencyKey).toMatch(/^hw-test:receipt_printer:/);
  });

  it('Remove button calls window.pos.devices.remove(id) and refetches', async () => {
    let listed = 0;
    listImpl = async () => {
      listed++;
      // First call: one row. After remove: empty.
      return {
        ok: true,
        rows: listed === 1 ? [row({ id: 99, role: 'cash_drawer' })] : [],
      };
    };
    const { HardwareDevicesPage } = await import('@/apps/platform/hardware/HardwareDevices');
    render(<HardwareDevicesPage />);
    const removeBtn = await screen.findByTestId('remove-99');
    fireEvent.click(removeBtn);
    await waitFor(() => {
      expect(removeCalls).toEqual([99]);
      expect(listed).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders Browser preview empty state when window.pos is absent (no crash)', async () => {
    (globalThis as { pos?: unknown }).pos = undefined;
    vi.resetModules();
    const { HardwareDevicesPage } = await import('@/apps/platform/hardware/HardwareDevices');
    render(<HardwareDevicesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Browser preview/i)).toBeTruthy();
    });
    expect(execCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });
});
