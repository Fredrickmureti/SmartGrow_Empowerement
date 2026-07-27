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

  it('has no role-only fallback left (Phase 5 Step C)', () => {
    // The legacy shims were deleted from HardwareClient. Every dispatch
    // resolves a `device_assignments` row first; an unresolvable intent
    // fails loudly instead of guessing a device by role.
    for (const method of [
      'printReceipt',
      'printKitchenOrder',
      'printRawBytes',
      'openDrawer',
      'readScale',
      'tareScale',
      'updateCustomerDisplay',
      'initiatePayment',
      'cancelPayment',
    ]) {
      expect(SRC, `${method} role-only shim must be gone`).not.toMatch(
        new RegExp(`hardwareClient\\.${method}\\(`),
      );
    }
    expect(SRC).toMatch(/no_device_bound/);
  });

  it('non-print roles (drawer, scale, display, payment) route through dispatchViaAssignment', () => {
    // Every non-print action method uses the shared helper as its primary
    // path — direct `hardwareClient.<method>()` calls at module scope are
    // reserved for the `legacy` fallback closure passed to the helper.
    expect(SRC).toMatch(/const dispatchViaAssignment = useCallback/);
    for (const role of ['cash_drawer', 'scale', 'customer_display', 'payment_terminal']) {
      expect(SRC, `dispatchViaAssignment should route the ${role} role`).toContain(`'${role}'`);
    }
  });
});
