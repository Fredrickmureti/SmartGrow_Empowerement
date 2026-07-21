/**
 * ADR-0087 — Phase 13 · labelDispatch error taxonomy guard.
 *
 * The Phase-13 root cause was that a seeded default row pinned to a media
 * profile caused the resolver to drop all matches when the caller had no
 * printer/workflow binding — and the dispatcher then reported "no template
 * registered", indistinguishable from a genuinely missing template.
 *
 * The fix in `src/services/printing/labelDispatch.ts` runs a `count`-head
 * lookup on `label_templates` when the resolver returns nothing, and emits
 * two different errors:
 *   - Zero rows exist    → "no label template registered for key '<key>'"
 *   - Rows exist but 0 resolved → sharpened "exists but could not be
 *     resolved for the requested scope (branch=…, media=…). Bind a label
 *     printer to workflow '<workflow>' in Platform → Hardware, or pass
 *     mediaProfileId explicitly."
 *
 * This test locks the taxonomy in with source inspection (matching
 * `label-dispatch-requires-media.test.ts`) so a refactor cannot collapse
 * the two branches back into a single ambiguous message. Cross-references
 * `label-dispatch-requires-media.test.ts` for the NO_MEDIA_RESOLVED case —
 * we intentionally do not duplicate that assertion here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../../services/printing/labelDispatch.ts'),
  'utf-8',
);

describe('labelDispatch · error taxonomy (ADR-0087 · Phase 13)', () => {
  it('runs a count-head lookup on label_templates when the resolver returns nothing', () => {
    // The `if (!tpl) { ... }` block must include a `count: 'exact', head: true`
    // query against public.label_templates scoped to org + template_key + active.
    expect(SRC).toMatch(/from\(\s*['"]label_templates['"]\s*\)/);
    expect(SRC).toMatch(/count:\s*['"]exact['"]/);
    expect(SRC).toMatch(/head:\s*true/);
  });

  it('scopes the head-count to org_id + template_key + active', () => {
    // Locate the count block and check the three equality filters.
    const countIdx = SRC.indexOf("count: 'exact'");
    expect(countIdx).toBeGreaterThan(-1);
    const block = SRC.slice(countIdx, countIdx + 400);
    expect(block).toMatch(/\.eq\(['"]org_id['"]/);
    expect(block).toMatch(/\.eq\(['"]template_key['"]/);
    expect(block).toMatch(/\.eq\(['"]active['"]/);
  });

  it('emits the sharpened "exists but could not be resolved" error when rows > 0', () => {
    // The sharpened message names branch + media scope and points to the
    // Platform → Hardware surface.
    expect(SRC).toMatch(/exists for this organization but could not be resolved/);
    expect(SRC).toMatch(/branch=/);
    expect(SRC).toMatch(/media=/);
    expect(SRC).toMatch(/Platform\s*→\s*Hardware/);
    expect(SRC).toMatch(/mediaProfileId explicitly/);
  });

  it('emits the plain "no label template registered" error only when zero rows exist', () => {
    // The plain message must live inside the `count === 0` branch — i.e.
    // it must appear AFTER the sharpened message in the file (the `return
    // if (count > 0)` guards it) and both must be inside the `if (!tpl)`
    // block.
    const notFoundIdx = SRC.indexOf('no label template registered');
    const sharpIdx = SRC.indexOf('exists for this organization but could not be resolved');
    const tplGuardIdx = SRC.indexOf('if (!tpl)');
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(sharpIdx).toBeGreaterThan(-1);
    expect(tplGuardIdx).toBeGreaterThan(-1);
    expect(sharpIdx).toBeGreaterThan(tplGuardIdx);
    expect(notFoundIdx).toBeGreaterThan(sharpIdx);
  });

  it('both taxonomy branches return `{ success: false, error }`, never throw', () => {
    const notFoundIdx = SRC.indexOf('no label template registered');
    const sharpIdx = SRC.indexOf('exists for this organization but could not be resolved');
    // Look ~200 chars back for the `return { success: false` and no `throw`.
    for (const idx of [notFoundIdx, sharpIdx]) {
      const window = SRC.slice(Math.max(0, idx - 200), idx);
      expect(window).toMatch(/return\s*{[\s\S]*success:\s*false/);
      expect(window).not.toMatch(/throw\s+new\s+/);
    }
  });

  it('mentions the workflow name in the sharpened error so operators can locate the binding', () => {
    // The sharpened error includes the workflow key so an operator on the
    // Platform → Hardware page knows which workflow binding is missing.
    const sharpIdx = SRC.indexOf('exists for this organization but could not be resolved');
    const window = SRC.slice(sharpIdx, sharpIdx + 400);
    expect(window).toMatch(/workflow/);
    expect(window).toMatch(/input\.workflow/);
  });
});
