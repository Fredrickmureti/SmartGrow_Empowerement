/**
 * Hardware Platform Consolidation — Phase 1 guardrail.
 *
 * Asserts the renderer's `DeviceRole` literal union (used by every
 * hardware hook and driver in `src/`) stays in exact parity with the
 * Electron main-process `HARDWARE_ROLES` tuple (used by the
 * `CommandRouter` runtime validator in `electron/hardware/`).
 *
 * Background: `electron/hardware/types.ts` claimed a "role-vocabulary"
 * CI test existed, but no such test was present in the repo. This is
 * that test. Do not weaken it — if a new role is legitimately added,
 * add it to BOTH files in the same change.
 *
 * Source inspection (not runtime import) so we don't pull the Electron
 * bundle into Vitest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ELECTRON = resolve(__dirname, '../../../electron/hardware/types.ts');
const RENDERER = resolve(__dirname, '../../services/hardware/drivers/DriverInterface.ts');

function extractElectronRoles(src: string): string[] {
  const m = src.match(/HARDWARE_ROLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!m) throw new Error('HARDWARE_ROLES tuple not found in electron/hardware/types.ts');
  return Array.from(m[1].matchAll(/['"]([a-z_]+)['"]/g)).map((x) => x[1]);
}

function extractRendererRoles(src: string): string[] {
  const m = src.match(/export\s+type\s+DeviceRole\s*=([\s\S]*?);/);
  if (!m) throw new Error('DeviceRole union not found in DriverInterface.ts');
  return Array.from(m[1].matchAll(/['"]([a-z_]+)['"]/g)).map((x) => x[1]);
}

describe('role vocabulary parity (Hardware Platform Phase 1)', () => {
  const electronRoles = extractElectronRoles(readFileSync(ELECTRON, 'utf-8'));
  const rendererRoles = extractRendererRoles(readFileSync(RENDERER, 'utf-8'));

  it('electron HARDWARE_ROLES is non-empty', () => {
    expect(electronRoles.length).toBeGreaterThan(0);
  });

  it('renderer DeviceRole is non-empty', () => {
    expect(rendererRoles.length).toBeGreaterThan(0);
  });

  it('every electron role exists in the renderer DeviceRole union', () => {
    const missingInRenderer = electronRoles.filter((r) => !rendererRoles.includes(r));
    expect(missingInRenderer).toEqual([]);
  });

  it('every renderer role exists in the electron HARDWARE_ROLES tuple', () => {
    const missingInElectron = rendererRoles.filter((r) => !electronRoles.includes(r));
    expect(missingInElectron).toEqual([]);
  });

  it('the two sets have identical cardinality', () => {
    expect(rendererRoles.length).toBe(electronRoles.length);
  });
});
