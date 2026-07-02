/**
 * Transport contract test — ADR-0014 Track 4 audit gap.
 *
 * Asserts the four new main-process transports (Usb, Serial, Cups,
 * WinSpooler) expose the uniform `{ send, test, isAvailable, disconnect }`
 * surface the HARDWARE_HANDLERS dispatcher relies on, plus the
 * transport-specific extensions (`list` on Usb/Serial, `subscribe` on
 * Serial). NetworkTransport is covered by the existing
 * device-manager-bootstrap test.
 *
 * The test only inspects the exported shape — it never calls `send()` —
 * so native bindings (`usb`, `serialport`) are never loaded in the
 * vitest jsdom run.
 */

import { describe, it, expect } from 'vitest';
import { UsbTransport } from '../../../../electron/hardware/transports/UsbTransport';
import { SerialTransport } from '../../../../electron/hardware/transports/SerialTransport';
import { CupsTransport } from '../../../../electron/hardware/transports/CupsTransport';
import { WinSpoolerTransport } from '../../../../electron/hardware/transports/WinSpoolerTransport';

const REQUIRED = ['send', 'test', 'isAvailable', 'disconnect'] as const;

function assertShape(name: string, t: Record<string, unknown>, extra: readonly string[] = []) {
  for (const k of REQUIRED) {
    expect(typeof t[k], `${name}.${k} must be a function`).toBe('function');
  }
  for (const k of extra) {
    expect(typeof t[k], `${name}.${k} must be a function`).toBe('function');
  }
}

describe('transport contract — uniform surface across USB/Serial/CUPS/WinSpooler', () => {
  it('UsbTransport exposes send/test/isAvailable/disconnect/list', () => {
    assertShape('UsbTransport', UsbTransport as unknown as Record<string, unknown>, ['list']);
  });

  it('SerialTransport exposes send/test/isAvailable/disconnect/list/subscribe', () => {
    assertShape('SerialTransport', SerialTransport as unknown as Record<string, unknown>, ['list']);
    // subscribe is the reader hook used by scale:read_weight
    const s = SerialTransport as unknown as Record<string, unknown>;
    const subscribeLike = typeof s.subscribe === 'function' || typeof s.openReader === 'function';
    expect(subscribeLike, 'SerialTransport must expose subscribe() or openReader()').toBe(true);
  });

  it('CupsTransport exposes send/test/isAvailable/disconnect', () => {
    assertShape('CupsTransport', CupsTransport as unknown as Record<string, unknown>);
  });

  it('WinSpoolerTransport exposes send/test/isAvailable/disconnect', () => {
    assertShape('WinSpoolerTransport', WinSpoolerTransport as unknown as Record<string, unknown>);
  });

  it('isAvailable() is platform-aware and never throws on the test host', () => {
    // WinSpooler only resolves on win32; the others depend on optional
    // native bindings — but isAvailable() must answer with a boolean, not
    // crash the renderer test bundle.
    expect(typeof UsbTransport.isAvailable()).toBe('boolean');
    expect(typeof SerialTransport.isAvailable()).toBe('boolean');
    expect(typeof CupsTransport.isAvailable()).toBe('boolean');
    expect(typeof WinSpoolerTransport.isAvailable()).toBe('boolean');
  });
});
