/**
 * Phase 5 Step B guard — Inventory's label-printer hook must dispatch
 * through `hardwareClient.execAssignment` whenever the platform resolver
 * (`useDeviceForRole`) surfaced a concrete `device_assignments` row.
 *
 * The workstation-relay probe fallback (`printLabelBytes`) is allowed but
 * only as a secondary path — this guard pins that exactly one such call
 * remains so a refactor cannot silently reinstate role-only dispatch as
 * the primary path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../../hooks/inventory/useInventoryLabelPrinter.ts'),
  'utf-8',
);

describe('useInventoryLabelPrinter — Phase 5 Step B per-assignment dispatch', () => {
  it('routes resolved devices through hardwareClient.execAssignment', () => {
    expect(SRC).toMatch(/hardwareClient\.execAssignment\(\{/);
    expect(SRC).toMatch(/op:\s*'print_raw'/);
  });

  it('forwards assignment.id and assignment.transport to execAssignment', () => {
    expect(SRC).toMatch(/id:\s*device\.id/);
    expect(SRC).toMatch(/transport:\s*device\.transport/);
  });

  it('keeps the role-only fallback strictly bounded (single call site)', () => {
    const hits = SRC.match(/hardwareClient\.printLabelBytes\(/g) ?? [];
    expect(hits.length).toBe(1);
  });
});
