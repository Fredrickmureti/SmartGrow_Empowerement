/**
 * Regression: MobileScannerPage used to call `useQrRepairScan` (and the
 * related useRef/useCallback) AFTER conditional early returns for
 * auth/loading splashes. When the splash returns stopped firing (auth
 * resolved, claim arrived), React saw extra hooks and threw
 * "Rendered more hooks than during the previous render", crashing the
 * phone mid-pairing.
 *
 * This test is a static guard: it asserts that the `useQrRepairScan`
 * call site appears in the source BEFORE the first `// -------- Render --------`
 * banner that introduces the early-return splashes. If a future edit
 * moves it back down, the test fails with a precise diagnostic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('MobileScannerPage — hook order stability', () => {
  it('useQrRepairScan is called before the conditional render returns', () => {
    const src = readFileSync(
      resolve(__dirname, '../../pages/pos/MobileScannerPage.tsx'),
      'utf8',
    );
    const renderBanner = src.indexOf('// -------- Render --------');
    const hookCall = src.indexOf('useQrRepairScan({');
    expect(renderBanner).toBeGreaterThan(0);
    expect(hookCall).toBeGreaterThan(0);
    expect(hookCall).toBeLessThan(renderBanner);
  });

  it('hoisted repair handler uses optional chaining on claim', () => {
    const src = readFileSync(
      resolve(__dirname, '../../pages/pos/MobileScannerPage.tsx'),
      'utf8',
    );
    const renderBanner = src.indexOf('// -------- Render --------');
    const above = src.slice(0, renderBanner);
    // Anything above the render banner runs before the splash early
    // returns, so `claim` may still be null there. Direct property
    // access (`claim.foo`) would crash.
    expect(above.includes('claim.register_name')).toBe(false);
  });
});

