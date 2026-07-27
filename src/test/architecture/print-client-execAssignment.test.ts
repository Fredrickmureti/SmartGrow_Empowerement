/**
 * Phase 5 Step B guard — `PrintClient` (the single-chokepoint facade for
 * every print path) MUST dispatch thermal/label bytes through
 * `hardwareClient.execAssignment` when the caller supplied both
 * `organizationId` and `businessId`. Legacy role-only shims
 * (`printRawBytes`, `printLabelBytes`) were deleted in Phase 5 Step C —
 * an unresolvable intent must fail loudly, never fall back to a role.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../../services/printing/PrintClient.ts'),
  'utf-8',
);

describe('PrintClient — Phase 5 Step B per-assignment dispatch', () => {
  it('exposes an organizationId on PrintRequest to enable per-assignment routing', () => {
    expect(SRC).toMatch(/organizationId\?:\s*string\s*\|\s*null/);
  });

  it('has a per-assignment thermal/label dispatcher', () => {
    expect(SRC).toMatch(/private\s+async\s+dispatchThermalBytes/);
    expect(SRC).toMatch(/hardwareClient\.execAssignment\(\{/);
    expect(SRC).toMatch(/resolveDeviceForIntent/);
  });

  it('routes both escpos and zpl branches through dispatchThermalBytes, not role-only shims', () => {
    // The escpos/zpl format branches inside `async print()` must delegate
    // to the per-assignment helper. Narrow the search window so the
    // legacy-fallback closure inside `dispatchThermalBytes` (which still
    // references the shim names) does not pollute this assertion.
    const printStart = SRC.indexOf('async print(');
    const printEnd = SRC.indexOf('private async dispatchThermalBytes', printStart);
    // `dispatchThermalBytes` is defined ABOVE `print()` in this file, so
    // once we find `print()` we walk forward to the next class method.
    const nextMethod = SRC.indexOf('\n  private ', printStart + 1);
    const end = nextMethod > 0 ? nextMethod : SRC.length;
    const printBlock = SRC.slice(printStart, end);
    void printEnd;
    expect(printBlock).toMatch(/this\.dispatchThermalBytes\(bytes,\s*req,\s*'receipt_printer'\)/);
    expect(printBlock).toMatch(/this\.dispatchThermalBytes\(bytes,\s*req,\s*'label_printer'\)/);
    expect(printBlock).not.toMatch(/hardwareClient\.printRawBytes\(bytes\)/);
    expect(printBlock).not.toMatch(/hardwareClient\.printLabelBytes\(bytes\)/);
  });

  it('has no role-only shim fallback left (Phase 5 Step C)', () => {
    expect(SRC).not.toMatch(/hardwareClient\.printRawBytes\(/);
    expect(SRC).not.toMatch(/hardwareClient\.printLabelBytes\(/);
    expect(SRC).toMatch(/no_device_bound/);
  });

  it('printKitchenTicket delegates to dispatchThermalBytes (no direct role-only shim)', () => {
    const idx = SRC.indexOf('async printKitchenTicket(');
    const end = SRC.indexOf('\n  async ', idx + 1);
    const block = SRC.slice(idx, end > 0 ? end : SRC.length);
    expect(block).toMatch(/this\.dispatchThermalBytes\(bytes,\s*req,\s*'kitchen_printer'\)/);
    expect(block).not.toMatch(/hardwareClient\.printRawBytes\(/);
  });
});
