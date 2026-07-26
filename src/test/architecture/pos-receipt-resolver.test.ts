/**
 * Phase 3 (Step A/B) — POS receipt + kitchen dispatch must resolve the
 * winning `device_assignments` row through the same server-authoritative
 * `resolve_device` RPC every other print surface uses. Role-only routing
 * inside the driver layer is fine as the physical exec, but the *decision*
 * of "which printer" must be shared with labels and edge functions.
 *
 * Source-inspection over a render test — `useHardwareProxy` has heavy
 * dependencies (React Query, hardware client, agent loop) whose mocks would
 * dwarf the assertion. The invariants below are the actual contract:
 *
 *   1. The hook imports `resolveDeviceForIntent`.
 *   2. Both `printReceipt` and `printKitchenOrder` call it before dispatch.
 *   3. The intent literals match `INTENT_TO_ROLE` keys (`receipt`,
 *      `kitchen_ticket`) — a typo cannot ship because the parity guard in
 *      `intent-to-role-parity.test.ts` locks the union.
 *   4. Unresolved devices short-circuit with a missing-device error instead
 *      of falling straight through to role dispatch.
 *   5. A structured `hardware.route.decision` log is emitted with intent +
 *      assignmentId (matches the Phase 6 DoD verification step).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOK = resolve(__dirname, '../../hooks/hardware/useHardwareProxy.ts');
const SRC = readFileSync(HOOK, 'utf-8');

describe('POS receipt/kitchen dispatch resolver contract (Phase 3 Step A/B)', () => {
  it('imports resolveDeviceForIntent from the intent façade', () => {
    expect(SRC).toMatch(
      /from\s+['"]@\/hooks\/useDeviceForIntent['"]/,
    );
    expect(SRC).toMatch(/resolveDeviceForIntent/);
  });

  it('resolves the receipt intent before dispatching', () => {
    // Slice from `const printReceipt =` up to the closing dependency array.
    const start = SRC.indexOf('const printReceipt =');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('const printRawBytes'));
    expect(body).toMatch(/resolveDeviceForIntent\s*\(/);
    expect(body).toMatch(/intentOrRole:\s*['"]receipt['"]/);
    expect(body).toMatch(/success:\s*false/); // missing-device short-circuit
  });

  it('resolves the kitchen_ticket intent before dispatching', () => {
    const start = SRC.indexOf('const printKitchenOrder =');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('const openDrawer'));
    expect(body).toMatch(/resolveDeviceForIntent\s*\(/);
    expect(body).toMatch(/intentOrRole:\s*['"]kitchen_ticket['"]/);
    expect(body).toMatch(/success:\s*false/);
  });

  it('emits a structured hardware.route.decision log for the resolver decision', () => {
    // Both hot lanes must log the decision so the Phase 6 DoD grep passes.
    const receiptBlock = SRC.slice(
      SRC.indexOf('const printReceipt ='),
      SRC.indexOf('const printRawBytes'),
    );
    const kitchenBlock = SRC.slice(
      SRC.indexOf('const printKitchenOrder ='),
      SRC.indexOf('const openDrawer'),
    );
    expect(receiptBlock).toMatch(/hardware\.route\.decision/);
    expect(kitchenBlock).toMatch(/hardware\.route\.decision/);
  });
});
