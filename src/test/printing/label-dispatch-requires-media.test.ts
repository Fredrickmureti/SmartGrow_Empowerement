/**
 * ADR-0087 · label dispatch must fail loud when no media resolves.
 *
 * Source-inspection guardrail. The heavy integration equivalent (mocking
 * supabase rpc + drivers) belongs in an e2e harness; here we lock in the
 * shape of the `NO_MEDIA_RESOLVED` contract so a future refactor cannot
 * silently regress to an unscaled label.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../../services/printing/labelDispatch.ts'),
  'utf-8',
);

describe('labelDispatch · NO_MEDIA_RESOLVED contract (ADR-0087)', () => {
  it('gates on tpl.engine being zpl or epl', () => {
    expect(SRC).toMatch(/tpl\.engine\s*===\s*['"]zpl['"]\s*\|\|\s*tpl\.engine\s*===\s*['"]epl['"]/);
  });

  it('returns a structured NO_MEDIA_RESOLVED error, does not throw', () => {
    expect(SRC).toContain('NO_MEDIA_RESOLVED');
    // Should be a `return { success: false, error: 'NO_MEDIA_RESOLVED…' }`
    // rather than `throw` — dispatch is expected to surface failures via
    // the LabelDispatchResult shape so callers can render a toast.
    const idx = SRC.indexOf('NO_MEDIA_RESOLVED');
    const window = SRC.slice(Math.max(0, idx - 200), idx);
    expect(window).toMatch(/return\s*{/);
    expect(window).not.toMatch(/throw\s+new\s+/);
  });

  it('directs the operator at the media admin surface', () => {
    expect(SRC).toMatch(/Platform\s*→\s*Hardware\s*→\s*Media/);
  });

  it('media resolution happens before the envelope-required check', () => {
    const mediaCall = SRC.indexOf('await resolvePrinterMedia(');
    const gate = SRC.indexOf('NO_MEDIA_RESOLVED');
    expect(mediaCall).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(mediaCall).toBeLessThan(gate);
  });

  it('does not apply the gate to escpos / pdf engines (receipts + A4 keep working)', () => {
    // The condition must NOT mention escpos or pdf — those engines don't
    // need a media_profile envelope injection.
    const idx = SRC.indexOf('NO_MEDIA_RESOLVED');
    const conditionWindow = SRC.slice(Math.max(0, idx - 400), idx);
    expect(conditionWindow).not.toMatch(/escpos/);
    expect(conditionWindow).not.toMatch(/['"]pdf['"]/);
  });
});
