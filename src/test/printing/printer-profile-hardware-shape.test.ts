/**
 * ADR-0087 + Phase 2b guardrail — the unified `device_assignments`
 * registry is the single source of hardware capability (command
 * language, DPI, paper size, supported media). The Phase 2a migration
 * folded `printer_profiles` into `device_assignments`; this test locks
 * down that `labelDispatch` reads capability from that canonical table,
 * NOT from ad-hoc per-device overrides in `assignment.config`.
 *
 * It also locks down the driver-side envelope contract that the label
 * body owns content only — the transport (ZPL `^PW/^LL`, EPL `q/Q`)
 * is emitted by the driver from the resolved media + dpi.
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

describe('labelDispatch reads hardware capability from device_assignments', () => {
  it("selects dpi and supported_media_ids from the unified 'device_assignments' registry", () => {
    expect(DISPATCH).toMatch(/from\(['"]device_assignments['"]\)/);
    expect(DISPATCH).toMatch(/dpi/);
    expect(DISPATCH).toMatch(/supported_media_ids/);
  });

  it('resolves the workflow-bound device via resolve_device_for_workflow, not the legacy resolver', () => {
    expect(DISPATCH).toMatch(/resolve_device_for_workflow/);
    expect(DISPATCH).not.toMatch(/resolve_workflow_printer/);
  });

  it('does NOT read hardware capability from the legacy printer_profiles table', () => {
    expect(DISPATCH).not.toMatch(/from\(['"]printer_profiles['"]\)/);
  });

  it('does NOT source dpi/widthMm from device_assignments.config', () => {
    // Per-device overrides in `config` are runtime-only — capability is a
    // first-class column on the assignment row and must be read as such.
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
