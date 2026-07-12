/**
 * ADR-0060 Phase E parity guard — the browser mirror of the block-
 * primitive certificate renderer must stay structurally identical to
 * the Deno version. If either grows a new block type, both files must
 * gain the same `case "..."` in the dispatch switch.
 *
 * The two files are line-for-line mirrors modulo the `pdf-lib` import
 * (`https://esm.sh/pdf-lib@1.17.1` in Deno, `"pdf-lib"` in the
 * browser) and the winansi/type import paths. This test compares the
 * set of `case "…"` labels in the top-level `renderCertificatePdfV2`
 * switch — the surface publishers actually consume.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const denoPath = resolve(__dirname, "../../../supabase/functions/_shared/pdf/certificateRendererV2.ts");
const browserPath = resolve(__dirname, "../../features/localization/lib/pdf/certificateRendererV2.ts");

function extractCases(src: string): string[] {
  const m = src.match(/switch \(block\.type\) \{([\s\S]*?)\n\s{4,}\}\n/);
  if (!m) return [];
  return Array.from(m[1].matchAll(/case\s+"([a-z_]+)"/g)).map((x) => x[1]).sort();
}

describe("certificateRendererV2 — browser/Deno parity", () => {
  const deno = readFileSync(denoPath, "utf8");
  const browser = readFileSync(browserPath, "utf8");

  it("both files export renderCertificatePdfV2", () => {
    expect(deno).toMatch(/export async function renderCertificatePdfV2\b/);
    expect(browser).toMatch(/export async function renderCertificatePdfV2\b/);
  });

  it("both files handle the same block types", () => {
    const denoCases = extractCases(deno);
    const browserCases = extractCases(browser);
    expect(denoCases.length).toBeGreaterThan(0);
    expect(browserCases).toEqual(denoCases);
  });

  it("both files declare the same computeLayoutV2 helper", () => {
    const grab = (src: string) => {
      const m = src.match(/export function computeLayoutV2[\s\S]*?\n\}/);
      return m?.[0].replace(/\s+/g, " ").trim();
    };
    expect(grab(browser)).toBe(grab(deno));
  });
});
