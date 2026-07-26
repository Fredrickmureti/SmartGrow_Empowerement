/**
 * Phase 5 Step B guard — `useHardwareProxy` MUST dispatch resolved intents
 * (receipt, kitchen ticket) through `hardwareClient.execAssignment` so the
 * `TransportRouter` decision is keyed off the winning assignment's
 * persisted `transport` value, not a fuzzy role-only fan-out at the driver
 * seam.
 *
 * Pure source-inspection guard — no React tree, no Supabase.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../../hooks/hardware/useHardwareProxy.ts'),
  'utf-8',
);

describe('useHardwareProxy — Phase 5 Step B per-assignment dispatch', () => {
  it('routes resolved receipts through hardwareClient.execAssignment', () => {
    // Must appear inside a block that mentions the receipt intent.
    const receiptBlock = SRC.slice(SRC.indexOf("intentOrRole: 'receipt'"));
    expect(receiptBlock).toMatch(/hardwareClient\.execAssignment\(\{/);
    expect(receiptBlock).toMatch(/op:\s*'print_receipt'/);
  });

  it('routes resolved kitchen tickets through hardwareClient.execAssignment', () => {
    const kitchenBlock = SRC.slice(SRC.indexOf("intentOrRole: 'kitchen_ticket'"));
    expect(kitchenBlock).toMatch(/hardwareClient\.execAssignment\(\{/);
  });

  it('passes assignment.transport (not role alone) to execAssignment', () => {
    expect(SRC).toMatch(/transport:\s*resolved\.transport/);
    expect(SRC).toMatch(/id:\s*resolved\.id/);
  });

  it('keeps the role-only fallback strictly gated behind resolver outage / no-org', () => {
    // The two remaining printReceipt / printKitchenOrder call sites are the
    // fallback path — they live after the try/catch. Assert there are
    // exactly two such calls (one per intent) so a future refactor cannot
    // silently reintroduce role-based dispatch as the primary path.
    const receiptHits = SRC.match(/hardwareClient\.printReceipt\(/g) ?? [];
    const kitchenHits = SRC.match(/hardwareClient\.printKitchenOrder\(/g) ?? [];
    expect(receiptHits.length).toBe(1);
    expect(kitchenHits.length).toBe(1);
  });
});
