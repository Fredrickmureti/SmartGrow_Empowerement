/**
 * Role vocabulary parity — Phase 1 guardrail (finished in Phase 2c).
 *
 * The hardware fabric has TWO in-repo canonical role vocabularies that must
 * stay identical: `HARDWARE_ROLES` in electron/hardware/types.ts (main-process
 * driver + queue) and the renderer `DeviceRole` union in
 * src/services/hardware/drivers/DriverInterface.ts. Any drift historically
 * caused silent "no printer for role" toasts when a role name was accepted
 * by one process and rejected by the other.
 *
 * This test locks the invariant and is the CI mirror of the plan's Phase 1
 * "role-vocabulary" guard. It does not import the Electron module (that would
 * pull node-only deps into the renderer test harness); instead it parses both
 * source files textually — a stable enough surface for a constants list.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function extractHardwareRoles(): string[] {
  const src = stripComments(
    readFileSync(resolve(ROOT, 'electron/hardware/types.ts'), 'utf8'),
  );
  const m = src.match(
    /export const HARDWARE_ROLES\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (!m) throw new Error('HARDWARE_ROLES literal not found in electron/hardware/types.ts');
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

function extractRendererDeviceRole(): string[] {
  const src = stripComments(
    readFileSync(resolve(ROOT, 'src/services/hardware/drivers/DriverInterface.ts'), 'utf8'),
  );
  const m = src.match(/export type DeviceRole\s*=\s*([\s\S]*?);/);
  if (!m) throw new Error('DeviceRole union not found in DriverInterface.ts');
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

describe('hardware role vocabulary parity', () => {
  it('renderer DeviceRole union equals Electron HARDWARE_ROLES set', () => {
    const electron = new Set(extractHardwareRoles());
    const renderer = new Set(extractRendererDeviceRole());
    const onlyInElectron = [...electron].filter((r) => !renderer.has(r)).sort();
    const onlyInRenderer = [...renderer].filter((r) => !electron.has(r)).sort();
    expect({ onlyInElectron, onlyInRenderer }).toEqual({
      onlyInElectron: [],
      onlyInRenderer: [],
    });
  });
});
