/**
 * Wave 7 — Inventory label-printer cross-module binding contract.
 *
 * Architecture-level guard. Pure source inspection — no React tree, no
 * Supabase. Validates the canonical pattern future modules (Warehouse, HR,
 * Manufacturing) must copy when consuming hardware bindings.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOK_PATH = resolve(__dirname, '../../hooks/inventory/useInventoryLabelPrinter.ts');
const src = readFileSync(HOOK_PATH, 'utf-8');

describe('useInventoryLabelPrinter (Wave 7 cross-module seam)', () => {
  it("routes hardware lookup through the platform hook, not the POS shim", () => {
    expect(src).toContain("from '@/hooks/useDeviceForRole'");
    expect(src).not.toContain("useDeviceRegistry");
    expect(src).not.toContain("pos_hardware_configs");
  });

  it("requests the canonical 'label_printer' role", () => {
    expect(src).toMatch(/useDeviceForRole\(\s*['"]label_printer['"]/);
  });

  it("surfaces a missing-device CTA pointing at Platform → Hardware", () => {
    expect(src).toContain('/platform/hardware/devices');
    expect(src).toMatch(/missingDeviceCta/);
  });

  it("dispatches label bytes through hardwareClient, not a direct driver", () => {
    // Phase 5 Step B: primary path is `execAssignment` (per-assignment,
    // transport chosen from the resolver row). `printLabelBytes` remains
    // only as the workstation-relay fallback when no resolver row surfaced.
    expect(src).toMatch(/hardwareClient\.(execAssignment|printLabelBytes)/);
    expect(src).not.toContain('browserHardwareAdapter');
    expect(src).not.toContain('agentClient');
  });

  it("returns a structured failure (not a throw) when no device is bound", () => {
    expect(src).toMatch(/success:\s*false/);
    expect(src).toMatch(/No label printer assigned/);
  });
});
