/**
 * Architecture guard — the pack-declared `outputs` array must round-trip
 * cleanly through the publisher UI: both the Certificate and Return
 * template editors mount the shared `OutputsCard`, both expose an
 * `outputs` field on their metadata shape, and `PackEntityTabs` includes
 * `outputs` in the metadata whitelist it persists.
 *
 * If any of these wires is silently removed, publishers can no longer
 * author multi-format templates and the generators fall back to the
 * legacy single-format path — a regression of the ADR 0060 architecture.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../../", rel), "utf8");

describe("pack-declared outputs — publisher round-trip", () => {
  it("ReturnTemplateEditor imports and renders OutputsCard bound to meta.outputs", () => {
    const src = read("src/features/localization/components/ReturnTemplateEditor.tsx");
    expect(src).toMatch(/from ["']\.\/OutputsCard["']/);
    expect(src).toMatch(/<OutputsCard[\s\S]*value=\{meta\.outputs\}/);
    expect(src).toMatch(/outputs:\s*Array<\{[\s\S]*format:\s*string/);
  });

  it("CertificateTemplateEditor imports and renders OutputsCard bound to meta.outputs", () => {
    const src = read("src/features/localization/components/CertificateTemplateEditor.tsx");
    expect(src).toMatch(/from ["']\.\/OutputsCard["']/);
    expect(src).toMatch(/<OutputsCard[\s\S]*value=\{meta\.outputs\}/);
  });

  it("PackEntityTabs persists outputs through the metadata whitelist", () => {
    const src = read("src/features/localization/components/PackEntityTabs.tsx");
    // outputs listed in the projection whitelist AND passed on save patch.
    expect(src).toMatch(/["']outputs["']/);
    expect(src.match(/outputs:\s*\(editing as any\)\.outputs\s*\?\?\s*null/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
  });

  it("OutputsCard preserves value shape (format+role+label+filename)", () => {
    const src = read("src/features/localization/components/OutputsCard.tsx");
    expect(src).toMatch(/format:\s*string/);
    expect(src).toMatch(/role\??:\s*string/);
    expect(src).toMatch(/label\??:\s*string\s*\|\s*null/);
    expect(src).toMatch(/filename\??:\s*string\s*\|\s*null/);
    // value===[] collapses to null so the generator legacy path kicks in.
    expect(src).toMatch(/arr\.length\s*\?\s*arr\s*:\s*null/);
  });
});