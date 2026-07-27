/**
 * ADR-0087 guardrail — the label dispatcher carries media geometry to
 * the driver. Envelope injection lives in ZplLabelDriver /
 * EplLabelDriver / BrowserHardwareAdapter; those code paths only fire
 * when the payload has `mediaWidthMm`, `mediaHeightMm`, and `dpi`. This
 * test is a source-inspection contract on `labelDispatch.ts` that keeps
 * the wiring intact:
 *
 *   1. resolves the workflow-bound printer BEFORE resolving the template
 *      (so the template resolver can pick the media-specific variant)
 *   2. resolves the printer's `supported_media_ids[0]` (or an explicit
 *      override) via `resolvePrinterMedia`
 *   3. passes `p_media_profile_id` into `resolve_label_template`
 *   4. attaches `mediaWidthMm` / `mediaHeightMm` / `dpi` to the payload
 *      handed to `hardwareClient.exec`
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../../services/printing/labelDispatch.ts'),
  'utf-8',
);

describe('labelDispatch · media flows through to the driver (ADR-0087)', () => {
  it('resolves media before the template (call-site order)', () => {
    // Phase 6 Step C: the physical printer is resolved downstream inside
    // execForIntent, not here. What must still hold is that media geometry
    // is resolved BEFORE the template, so the template resolver can pick
    // the media-specific variant via p_media_profile_id.
    const mediaIdx = SRC.indexOf('await resolvePrinterMedia(');
    const templateIdx = SRC.indexOf('await resolveTemplate(');
    expect(mediaIdx).toBeGreaterThan(-1);
    expect(templateIdx).toBeGreaterThan(-1);
    expect(mediaIdx).toBeLessThan(templateIdx);
  });


  it('resolves media from the printer profile', () => {
    expect(SRC).toMatch(/resolvePrinterMedia\s*\(/);
    expect(SRC).toMatch(/supported_media_ids/);
  });

  it('passes p_media_profile_id to resolve_label_template', () => {
    expect(SRC).toMatch(/p_media_profile_id\s*:/);
  });

  it('attaches media geometry + dpi to the driver payload', () => {
    expect(SRC).toMatch(/payload\.mediaWidthMm\s*=/);
    expect(SRC).toMatch(/payload\.mediaHeightMm\s*=/);
    expect(SRC).toMatch(/payload\.dpi\s*=/);
  });

  it('never embeds envelope commands in the rendered body', () => {
    expect(SRC).not.toMatch(/\^PW\$?\{|\^PW\d/);
    expect(SRC).not.toMatch(/\^LL\$?\{|\^LL\d/);
  });
});
