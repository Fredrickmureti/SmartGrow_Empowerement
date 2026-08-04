/**
 * Guard: execution is keyed by the resolved assignment, not by role.
 *
 * The pre-consolidation defect was that `execAssignment` resolved the right
 * `device_assignments` row and then threw the result away, falling back to
 * `execAny(role)` against the renderer's role-keyed registry. Invoices
 * "printed" into a registry that was empty; labels reported no printer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('hardware execution path', () => {
  it('execAssignment dispatches by assignment, never by role fallback', () => {
    const src = read('src/services/hardware/HardwareClient.ts');
    const body = src.slice(src.indexOf('async execAssignment('));
    const scoped = body.slice(0, body.indexOf('\n  async ', 10));
    expect(scoped).toMatch(/dispatchToAssignment/);
    expect(scoped).not.toMatch(/execAny\(/);
  });

  it('EdgeRelayMount owns relay config only, not a device registry', () => {
    const src = read('src/components/hardware/EdgeRelayMount.tsx');
    expect(src).not.toMatch(/loadAssignments|connectAll/);
  });

  it('no surface filters device_assignments on the dead "ok" status', () => {
    const src = read('src/hooks/inventory/useInventoryLabelPrinter.ts');
    expect(src).not.toMatch(/'ok',\s*'unknown'/);
  });
});