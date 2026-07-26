/**
 * Phase 5 Step B guard — `PrintClient` (the single-chokepoint facade for
 * every print path) MUST dispatch thermal/label bytes through
 * `hardwareClient.execAssignment` when the caller supplied both
 * `organizationId` and `businessId`. Legacy role-only shims
 * (`printRawBytes`, `printLabelBytes`) are allowed ONLY as the
 * resolver-outage fallback path.
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
    // Both format branches must call the per-assignment dispatcher and
    // must NOT call the legacy role-only shims directly at the printsite.
    const printBlock = SRC.slice(SRC.indexOf('async print('));
    expect(printBlock).toMatch(/this\.dispatchThermalBytes\(bytes,\s*req,\s*'receipt_printer'\)/);
    expect(printBlock).toMatch(/this\.dispatchThermalBytes\(bytes,\s*req,\s*'label_printer'\)/);
    // Legacy shims only appear inside the `legacy` closure of the helper,
    // not at the escpos/zpl format branches themselves.
    expect(printBlock).not.toMatch(/hardwareClient\.printRawBytes\(bytes\)/);
    expect(printBlock).not.toMatch(/hardwareClient\.printLabelBytes\(bytes\)/);
  });

  it('bounds the legacy role-only shims to the helper fallback (single call site each)', () => {
    const rawHits = SRC.match(/hardwareClient\.printRawBytes\(/g) ?? [];
    const labelHits = SRC.match(/hardwareClient\.printLabelBytes\(/g) ?? [];
    // 1 remaining `printRawBytes` inside `dispatchThermalBytes` fallback +
    // 1 in the legacy `printKitchenTicket` helper (line ~483) that is not
    // yet migrated. Track that number so a regression trips this guard.
    expect(rawHits.length).toBeLessThanOrEqual(2);
    expect(labelHits.length).toBe(1);
  });
});
