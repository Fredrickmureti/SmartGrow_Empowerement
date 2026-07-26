import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareVersions, rolloutBucket } = require('../../../packages/desktop/electron/updater.cjs');

/**
 * Phase 4.2.8 guard tests — the two pure decisions that gate whether a
 * workstation receives a staged release.
 */
describe('update channel logic', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });

  it('assigns a stable rollout bucket per install id', () => {
    const a = rolloutBucket('ws-123');
    expect(rolloutBucket('ws-123')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('spreads buckets across the range so partial rollouts are meaningful', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `ws-${i}`);
    const inTenPercent = ids.filter((id) => rolloutBucket(id) < 0.1).length;
    // Binomial around 50; allow generous slack while still catching a
    // degenerate hash that buckets everything to one end.
    expect(inTenPercent).toBeGreaterThan(20);
    expect(inTenPercent).toBeLessThan(85);
  });
});
