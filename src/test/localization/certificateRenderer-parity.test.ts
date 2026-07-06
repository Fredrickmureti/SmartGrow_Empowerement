/**
 * Parity test — the browser certificateRenderer MUST support the same
 * section-type switch cases as the Deno-side renderer, and MUST export
 * the same top-level `renderCertificatePdf` function. If either file
 * grows a new section type, the other one must gain the same case in
 * the same commit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const denoPath = resolve(__dirname, "../../../supabase/functions/_shared/pdf/certificateRenderer.ts");
const browserPath = resolve(__dirname, "../../features/localization/lib/pdf/certificateRenderer.ts");

function extractSwitchCases(src: string): string[] {
  // Match `case "xxx":` inside the top-level dispatch switch.
  const m = src.match(/switch \(type\) \{([\s\S]*?)\n\s{4,}\}\n/);
  if (!m) return [];
  return Array.from(m[1].matchAll(/case\s+"([a-z_]+)"/g)).map((x) => x[1]).sort();
}

describe("certificateRenderer — browser/Deno parity", () => {
  const deno = readFileSync(denoPath, "utf8");
  const browser = readFileSync(browserPath, "utf8");

  it("both files export renderCertificatePdf", () => {
    expect(deno).toMatch(/export async function renderCertificatePdf\b/);
    expect(browser).toMatch(/export async function renderCertificatePdf\b/);
  });

  it("both files handle the same section types", () => {
    const denoCases = extractSwitchCases(deno);
    const browserCases = extractSwitchCases(browser);
    expect(denoCases.length).toBeGreaterThan(0);
    expect(browserCases).toEqual(denoCases);
  });

  it("both files use identical layout constants", () => {
    const grab = (src: string, name: string) => {
      const m = src.match(new RegExp(`const ${name}[^;]+`));
      return m?.[0].replace(/\s+/g, " ").trim();
    };
    for (const name of ["MARGIN", "PAGE_W", "PAGE_H", "CONTENT_W"]) {
      expect(grab(browser, name)).toBe(grab(deno, name));
    }
  });
});
