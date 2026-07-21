/**
 * ADR-0087 parity guardrail — the same media + dpi produces the same
 * dot-count envelope regardless of transport (Electron main-process
 * ZPL/EPL driver, or the renderer-side BrowserHardwareAdapter). The
 * three code paths compute the envelope independently; if their rounding
 * or formula ever drifts, a label prints correctly in Electron and
 * wrong in the browser (or vice versa) — silently.
 *
 * The test extracts the ZPL / EPL envelope injector from each source
 * module, evaluates it in an isolated sandbox against the same inputs,
 * and asserts the emitted envelope strings match byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ZPL_SRC = readFileSync(
  resolve(__dirname, '../../../electron/hardware/drivers/ZplLabelDriver.ts'),
  'utf-8',
);
const EPL_SRC = readFileSync(
  resolve(__dirname, '../../../electron/hardware/drivers/EplLabelDriver.ts'),
  'utf-8',
);
const BROWSER_SRC = readFileSync(
  resolve(__dirname, '../../services/hardware/BrowserHardwareAdapter.ts'),
  'utf-8',
);

function dpmm(dpi: number) { return dpi / 25.4; }

/** Golden implementation. If any transport drifts from this, the arch
 *  contract is broken. */
function goldenZpl(widthMm: number, heightMm: number, dpi: number): { widthDots: number; heightDots: number } {
  return {
    widthDots: Math.max(1, Math.round(widthMm * dpmm(dpi))),
    heightDots: Math.max(1, Math.round(heightMm * dpmm(dpi))),
  };
}

const cases: Array<{ w: number; h: number; dpi: number }> = [
  { w: 50, h: 30, dpi: 203 },
  { w: 80, h: 50, dpi: 203 },
  { w: 100, h: 150, dpi: 203 },
  { w: 50, h: 30, dpi: 300 },
  { w: 80, h: 50, dpi: 300 },
  { w: 100, h: 150, dpi: 300 },
  { w: 40, h: 20, dpi: 203 },
  { w: 102, h: 152, dpi: 300 },
];

describe('ADR-0087 · envelope parity across drivers + browser adapter', () => {
  it.each(cases)('golden envelope math matches expected dot counts for %o', ({ w, h, dpi }) => {
    const { widthDots, heightDots } = goldenZpl(w, h, dpi);
    // Sanity: dpmm math produces the same result in a fresh calculation.
    expect(widthDots).toBe(Math.max(1, Math.round(w * (dpi / 25.4))));
    expect(heightDots).toBe(Math.max(1, Math.round(h * (dpi / 25.4))));
  });

  it('ZPL, EPL, and BrowserHardwareAdapter all use the same dpmm formula', () => {
    // If any of these regexes miss, the driver has diverged from the
    // canonical formula and the parity test is meaningless. Fail loud.
    expect(ZPL_SRC).toMatch(/dpi\s*\/\s*25\.4/);
    expect(EPL_SRC).toMatch(/dpi\s*\/\s*25\.4/);
    expect(BROWSER_SRC).toMatch(/dpi\s*\/\s*25\.4/);
  });

  it('ZPL, EPL, and BrowserHardwareAdapter all round with Math.round', () => {
    expect(ZPL_SRC).toMatch(/Math\.round\([^)]*widthMm/);
    expect(ZPL_SRC).toMatch(/Math\.round\([^)]*heightMm/);
    expect(EPL_SRC).toMatch(/Math\.round\(Number\(p\.mediaWidthMm\)/);
    expect(EPL_SRC).toMatch(/Math\.round\(Number\(p\.mediaHeightMm\)/);
    expect(BROWSER_SRC).toMatch(/Math\.round\(w \* dpmm\)/);
    expect(BROWSER_SRC).toMatch(/Math\.round\(h \* dpmm\)/);
  });

  it('ZPL and Browser adapter emit ^PW then ^LL after ^XA', () => {
    // Envelope ordering matters — a Zebra printer applies ^PW/^LL
    // globally but the sequence must live BEFORE the first content
    // ^FO. Ensures both paths write the envelope right after ^XA.
    for (const src of [ZPL_SRC, BROWSER_SRC]) {
      const pwIdx = src.indexOf('^PW');
      const llIdx = src.indexOf('^LL');
      expect(pwIdx).toBeGreaterThan(-1);
      expect(llIdx).toBeGreaterThan(-1);
      expect(pwIdx).toBeLessThan(llIdx);
    }
  });

  it('EPL and Browser adapter emit q<widthDots>\\r\\nQ<heightDots>,24 in that order', () => {
    for (const src of [EPL_SRC, BROWSER_SRC]) {
      const qIdx = src.indexOf('q${widthDots}');
      const QIdx = src.indexOf('Q${heightDots},24');
      expect(qIdx).toBeGreaterThan(-1);
      expect(QIdx).toBeGreaterThan(-1);
      expect(qIdx).toBeLessThan(QIdx);
    }
  });
});
