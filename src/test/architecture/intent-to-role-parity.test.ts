/**
 * intent-to-role-parity — architectural guard.
 *
 * The client `useDeviceForIntent` exports `INTENT_TO_ROLE`, the canonical
 * bridge from `PrintClient.PrintIntent` values to `device_assignments.role`
 * values. Any print path (POS receipt, kitchen ticket, label, A4 document,
 * packing slip) must map through this table so that the server-side
 * `resolve_device` RPC and the browser UI never diverge on which physical
 * printer receives a given intent.
 *
 * This test locks two invariants:
 *
 *   1. Every `PrintIntent` union member has an entry in `INTENT_TO_ROLE`.
 *      If a new intent is added, the map must grow with it — otherwise the
 *      resolver silently falls back to treating the intent as a raw role.
 *
 *   2. Every mapped role is one of the canonical hardware roles supported
 *      by the drivers (`DeviceRole` union). This keeps the mapping honest:
 *      a typo like `receiepe_printer` would be caught here rather than at
 *      runtime on a real POS terminal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INTENT_TO_ROLE } from '@/hooks/useDeviceForIntent';

function readSource(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), 'utf8');
}

function extractUnionMembers(src: string, typeName: string): string[] {
  const re = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*([^;]+);`, 'm');
  const match = src.match(re);
  if (!match) throw new Error(`type ${typeName} not found`);
  const body = match[1];
  // Strip block/line comments before parsing string literals.
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const literals = stripped.match(/'([^']+)'/g) ?? [];
  return literals.map((l) => l.slice(1, -1));
}

describe('intent → role mapping parity', () => {
  // `PrintIntent` lives in the shared printing vocabulary, not in the
  // dispatch client, so intent-based routing has no dependency on it.
  const intentSrc = readSource('src/services/printing/types.ts');
  const driverSrc = readSource('src/services/hardware/drivers/DriverInterface.ts');

  const intents = extractUnionMembers(intentSrc, 'PrintIntent');
  const roles = extractUnionMembers(driverSrc, 'DeviceRole');

  it('covers every PrintIntent union member', () => {
    const missing = intents.filter((i) => !(i in INTENT_TO_ROLE));
    expect(missing, `INTENT_TO_ROLE is missing entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('maps only to canonical DeviceRole values', () => {
    const bad = Object.entries(INTENT_TO_ROLE).filter(
      ([, role]) => !roles.includes(role),
    );
    expect(
      bad,
      `INTENT_TO_ROLE points at non-canonical roles: ${bad.map(([k, v]) => `${k}→${v}`).join(', ')}`,
    ).toEqual([]);
  });

  it('has no orphaned intents beyond the PrintIntent union', () => {
    const extra = Object.keys(INTENT_TO_ROLE).filter((k) => !intents.includes(k));
    expect(extra, `INTENT_TO_ROLE has stale entries: ${extra.join(', ')}`).toEqual([]);
  });
});
