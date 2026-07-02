/**
 * Wave 9d — runtimeCapability() probe shape test.
 *
 * Verifies the probe returns the expected envelope in two environments:
 *   - jsdom (no window.pos, no navigator.usb)         → browser/unsupported
 *   - jsdom with mocked window.pos.hardware.capabilities → electron
 *
 * The IoT-agent branch is exercised indirectly by AgentClient tests; we
 * don't spin up a real HTTP listener here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runtimeCapability, invalidateRuntimeCapability } from '@/services/hardware/HardwareClient';

describe('runtimeCapability', () => {
  beforeEach(() => {
    invalidateRuntimeCapability();
    // Clear any window.pos mock between tests
    delete (window as unknown as { pos?: unknown }).pos;
  });

  it('returns browser or unsupported when no Electron bridge is present', async () => {
    const cap = await runtimeCapability();
    expect(['browser', 'unsupported', 'iot-agent']).toContain(cap.runtime);
    expect(cap.transports).toHaveProperty('usb');
    expect(cap.transports).toHaveProperty('serial');
    expect(cap.transports).toHaveProperty('hid');
    expect(Array.isArray(cap.warnings)).toBe(true);
    expect(Array.isArray(cap.ops)).toBe(true);
  });

  it('returns electron runtime when window.pos.hardware.capabilities resolves', async () => {
    (window as unknown as { pos: unknown }).pos = {
      isElectron: true,
      hardware: {
        exec: vi.fn(),
        subscribe: vi.fn(),
        capabilities: vi.fn().mockResolvedValue({
          ok: true,
          runtime: 'electron',
          platform: 'linux',
          preloadBuild: '9d-test',
          transports: {
            usb: 'native', serial: 'native', hid: 'native',
            network: 'native', cups: 'unavailable', bluetooth: 'native',
          },
          ops: ['print_receipt', 'open'],
        }),
      },
    };
    const cap = await runtimeCapability();
    expect(cap.runtime).toBe('electron');
    expect(cap.preloadBuild).toBe('9d-test');
    expect(cap.transports.usb).toBe('native');
    expect(cap.ops).toContain('print_receipt');
  });

  it('surfaces a warning when a transport reports unavailable in Electron', async () => {
    (window as unknown as { pos: unknown }).pos = {
      isElectron: true,
      hardware: {
        exec: vi.fn(),
        subscribe: vi.fn(),
        capabilities: vi.fn().mockResolvedValue({
          ok: true,
          runtime: 'electron',
          platform: 'linux',
          preloadBuild: '9d-test',
          transports: {
            usb: 'unavailable', serial: 'native', hid: 'native',
            network: 'native', cups: 'unavailable', bluetooth: 'native',
          },
          ops: [],
        }),
      },
    };
    const cap = await runtimeCapability();
    expect(cap.warnings.some((w) => w.includes('usb'))).toBe(true);
  });

  it('caches results for repeat calls', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true, runtime: 'electron', platform: 'linux', preloadBuild: 'cache-test',
      transports: { usb: 'native', serial: 'native', hid: 'native', network: 'native', cups: 'native', bluetooth: 'native' },
      ops: [],
    });
    (window as unknown as { pos: unknown }).pos = {
      isElectron: true,
      hardware: { exec: vi.fn(), subscribe: vi.fn(), capabilities: spy },
    };
    await runtimeCapability();
    await runtimeCapability();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
