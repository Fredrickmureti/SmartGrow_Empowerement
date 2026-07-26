/**
 * Plan phase G · Guardrail G1 — no shadow `window.print()` / print-iframe
 * paths outside the sanctioned print pipeline.
 *
 * The single-chokepoint invariant established by Waves B/P is that every
 * business-document print (invoice, receipt, delivery note, label, kitchen
 * ticket, …) funnels through `printClient.print()` → `printPdfInPage()`
 * (PDF branch) or `hardwareClient.printRawBytes/printLabelBytes` (thermal
 * branch). Any other file spawning its own print-iframe or calling
 * `window.print()` / `contentWindow.print()` re-creates the shadow path
 * that Plan P1 killed and re-opens the "N clicks → 1 job" regression.
 *
 * Allow-list carves out the pipeline owner and the localization
 * certificate preview surface (a standalone HTML overlay unrelated to the
 * document pipeline; regulator-issued certificates are printed directly
 * from a designer preview, not from a stored document).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");

/** Files permitted to create a print iframe. */
const IFRAME_ALLOWED = new Set<string>([
  "services/printing/pdfUtils.ts",
  "features/localization/lib/printCertificateHtml.ts",
]);

/** Files permitted to call `.print()` on a window / iframe contentWindow. */
const PRINT_CALL_ALLOWED = new Set<string>([
  "services/printing/pdfUtils.ts",
  "features/localization/lib/printCertificateHtml.ts",
  "features/localization/components/CertificateHtmlSurface.tsx",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tanstack") continue;
    if (entry === "test" || entry === "__tests__") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("print single chokepoint · guard G1 (no shadow window.print / iframe)", () => {
  it("no src/ file creates a print iframe outside the pipeline allow-list", () => {
    const re = /createElement\(\s*['"`]iframe['"`]\s*\)/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (IFRAME_ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (re.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files creating an <iframe> outside the print-pipeline owners:\n${offenders.join("\n")}\n\n` +
        `Route document prints through printClient.print() instead of spawning a print iframe.`,
    ).toEqual([]);
  });

  it("no src/ file calls window.print() / contentWindow.print() outside the allow-list", () => {
    // Matches `win.print()`, `window.print()`, `cw.print()`, `contentWindow.print()`.
    // We tolerate `.print()` calls on identifiers that clearly are not a Window
    // (hardwareClient, printClient, agent, driver, etc.) by requiring the receiver
    // to look like a window/iframe handle.
    const re = /\b(window|win|cw|contentWindow|iframe\.contentWindow)\s*\??\.\s*print\s*\(/;
    const offenders: string[] = [];
    for (const abs of walk(ROOT)) {
      const rel = relative(ROOT, abs).split("\\").join("/");
      if (PRINT_CALL_ALLOWED.has(rel)) continue;
      const text = readFileSync(abs, "utf-8");
      if (re.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Files calling window.print()/contentWindow.print() outside the allow-list:\n${offenders.join(
        "\n",
      )}\n\nThese re-open the shadow print path Plan P1 collapsed. Route through printClient.print().`,
    ).toEqual([]);
  });
});
