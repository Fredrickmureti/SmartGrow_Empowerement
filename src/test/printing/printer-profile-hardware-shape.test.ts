/**
 * ADR-0087 guardrail — printer_profiles is the source of hardware
 * capability (command language, DPI, supported media). This test locks
 * down two contracts that keep the architecture from silently reverting:
 *
 *   1. `labelDispatch` reads `dpi` and `supported_media_ids` from
 *      `printer_profiles`, NOT from `device_assignments.config`.
 *   2. Label drivers (`ZplLabelDriver`, `EplLabelDriver`) prefer payload
 *      media hints (which originate from `printer_profiles` +
 *      `media_profiles`) over `assignment.config.{dpi,widthMm,heightMm}`,
 *      and strip any body-embedded envelope before writing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DISPATCH = readFileSync(
  resolve(__dirname, '../../services/printing/labelDispatch.ts'),
  'utf-8',
);
const ZPL = readFileSync(
  resolve(__dirname, '../../../electron/hardware/drivers/ZplLabelDriver.ts'),
  'utf-8',
);
const EPL = readFileSync(
  resolve(__dirname, '../../../electron/hardware/drivers/EplLabelDriver.ts'),
  'utf-8',
);
const BROWSER = readFileSync(
  resolve(__dirname, '../../services/hardware/BrowserHardwareAdapter.ts'),
  'utf-8',
);

describe('labelDispatch reads hardware capability from printer_profiles', () => {
  it("selects dpi and supported_media_ids from 'printer_profiles'", () => {
    expect(DISPATCH).toMatch(/from\(['"]printer_profiles['"]\)/);
    expect(DISPATCH).toMatch(/dpi/);
    expect(DISPATCH).toMatch(/supported_media_ids/);
  });

  it('does NOT source dpi/widthMm from device_assignments.config', () => {
    // Dispatch code should never reach for the ad-hoc per-device override.
    expect(DISPATCH).not.toMatch(/device_assignments/);
    expect(DISPATCH).not.toMatch(/assignment\.config\.(dpi|widthMm|heightMm)/);
  });
});

describe('ZplLabelDriver honours payload media hints over assignment.config', () => {
  it('prefers payload.mediaWidthMm / mediaHeightMm / dpi', () => {
    expect(ZPL).toMatch(/payload\?\.mediaWidthMm/);
    expect(ZPL).toMatch(/payload\?\.mediaHeightMm/);
    expect(ZPL).toMatch(/payload\?\.dpi/);
  });

  it('strips any body-embedded envelope before writing', () => {
    expect(ZPL).toMatch(/stripEnvelope/);
    expect(ZPL).toMatch(/\\\^PW\\d\+|\/\\\^PW/);
  });

  it('emits the envelope from the resolved dpi via mediaGeometry.mediaDots', () => {
    // Phase 14: transports delegate to mediaGeometry; they no longer
    // own `dpi / 25.4`. What we care about here is that the envelope
    // tokens (`^PW`, `^LL`) are emitted from the mediaDots result.
    expect(ZPL).toMatch(/mediaDots\(/);
    expect(ZPL).toMatch(/\^PW\$\{/);
    expect(ZPL).toMatch(/\^LL\$\{/);
  });
});

describe('EplLabelDriver injects q/Q envelope from media hints', () => {
  it('strips embedded q<dots> / Q<dots>,<gap> before re-emitting', () => {
    expect(EPL).toMatch(/applyEnvelope/);
    expect(EPL).toMatch(/q\\d\+/);
    expect(EPL).toMatch(/Q\\d\+,\\d\+/);
  });

  it('re-emits q<widthDots> / Q<heightDots>,24 from media + dpi (via mediaGeometry)', () => {
    expect(EPL).toMatch(/mediaDots\(/);
    expect(EPL).toMatch(/q\$\{widthDots\}/);
    expect(EPL).toMatch(/Q\$\{heightDots/);
  });
});

describe('BrowserHardwareAdapter mirrors driver envelope logic on the browser path', () => {
  it('has a ZPL envelope injector that strips ^PW/^LL and re-emits from media hints', () => {
    expect(BROWSER).toMatch(/injectZplEnvelope/);
    expect(BROWSER).toMatch(/\\\^PW\\d\+/);
    expect(BROWSER).toMatch(/\\\^LL\\d\+/);
  });

  it('has an EPL envelope injector that mirrors the main-process driver', () => {
    expect(BROWSER).toMatch(/injectEplEnvelope/);
    expect(BROWSER).toMatch(/q\$\{widthDots\}/);
    expect(BROWSER).toMatch(/Q\$\{heightDots/);
  });

  it('runs both injectors when routing label_printer:print_raw / print_label', () => {
    expect(BROWSER).toMatch(/injectZplEnvelope\(raw\.zpl, raw\)/);
    expect(BROWSER).toMatch(/injectEplEnvelope\(raw\.epl, raw\)/);
  });
});
