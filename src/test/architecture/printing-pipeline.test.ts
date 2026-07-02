/**
 * Architecture guard: `openPdfInNewTab` is the explicit-opt-in print path
 * and must NOT be used as a silent fallback by other modules.
 *
 * See docs/printing-pipeline.md. The only sanctioned importers are:
 *  - src/services/printing/previewSurface.ts (explicit "preview in new tab")
 *  - src/services/printing/PrintClient.ts    (explicit user-opted fallback)
 *  - src/services/printing/pdfUtils.ts       (definition site)
 *
 * Tests may import it (mock setup). Anything else is a regression —
 * route the change through `printPdfInPage` so failures surface as
 * proper errors instead of suddenly opening browser tabs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");

const ALLOWED = new Set([
  "services/printing/pdfUtils.ts",
  "services/printing/previewSurface.ts",
  "services/printing/PrintClient.ts",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tanstack") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("Printing pipeline: openPdfInNewTab is restricted", () => {
  it("openPdfInNewTab is only imported by the sanctioned printing modules", () => {
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      // Tests may reference the symbol freely (mocking the module).
      if (rel.startsWith("test/")) continue;
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (/\bopenPdfInNewTab\b/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "openPdfInNewTab is the explicit opt-in path (see docs/printing-pipeline.md). " +
        "Route through printPdfInPage so failures surface as errors. Offenders:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
