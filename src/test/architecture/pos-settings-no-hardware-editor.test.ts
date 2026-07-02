/**
 * Wave 8 architecture guard — POS settings must not re-introduce the
 * embedded hardware editor.
 *
 * The hardware tab in `POSSettings.tsx` is intentionally a redirect-only
 * CTA pointing at Platform → Hardware. Re-adding `DeviceRegistryCard`
 * here would restore a duplicate write surface for hardware bindings,
 * which the platform-hardware audit explicitly forbids.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(__dirname, '../../pages/pos/POSSettings.tsx');
const src = readFileSync(FILE, 'utf-8');

describe('POSSettings (Wave 8 hardware-tab redirect contract)', () => {
  it('does not import DeviceRegistryCard', () => {
    expect(src).not.toMatch(/^import\s+\{[^}]*DeviceRegistryCard[^}]*\}\s+from/m);
    expect(src).not.toMatch(/^import\s+DeviceRegistryCard\s+from/m);
  });

  it('does not render <DeviceRegistryCard>', () => {
    expect(src).not.toMatch(/<DeviceRegistryCard[\s/>]/);
  });

  it('hardware tab points operators at the platform hardware surface', () => {
    expect(src).toContain('/platform/hardware/devices');
  });
});
