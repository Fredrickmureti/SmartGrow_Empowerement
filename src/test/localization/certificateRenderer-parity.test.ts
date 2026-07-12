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

  it("both files derive layout via an identical computeLayout(template) helper", () => {
    // Layout is now template-driven (portrait vs landscape) instead of a
    // module constant. Both renderers must derive it the same way — a
    // divergence would silently ship a P9 that fits KRA's official
    // template on the server but overflows in the publisher preview.
    const grab = (src: string) => {
      const m = src.match(/export function computeLayout[\s\S]*?\n\}/);
      return m?.[0].replace(/\s+/g, " ").trim();
    };
    const d = grab(deno);
    const b = grab(browser);
    expect(d, "Deno computeLayout not found").toBeTruthy();
    expect(b, "Browser computeLayout not found").toBeTruthy();
    expect(b).toBe(d);
  });
});
