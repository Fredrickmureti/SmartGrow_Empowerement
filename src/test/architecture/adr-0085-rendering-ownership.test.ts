/**
 * ADR-0085 — rendering ownership guards (runtime mirror of the
 * `no-raw-pdf-lib-in-app` and `no-direct-barcode-lib` ESLint rules).
 *
 * These tests exist so the architectural invariant holds even when
 * ESLint is skipped (CI edits, custom lint configs, editor lint off).
 *
 * - `pdf-lib` may not be imported from any `src/**` file.
 * - `bwip-js` and the raw `qrcode` package may not be imported from
 *   any `src/**` file. `qrcode.react` remains allowed (on-screen SVG
 *   display component; not a printable rasteriser).
 *
 * Per-line opt-out: `// RENDERER-EXEMPT: <reason>` on the line
 * immediately preceding the import.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../src");

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

/**
 * Match `from "<mod>"` / `from '<mod>'` and `import("<mod>")`, where
 * `<mod>` is either exactly `pkg` or starts with `pkg/`.
 */
function importedFrom(text: string, pkg: string): { line: number; raw: string }[] {
  const hits: { line: number; raw: string }[] = [];
  const patterns = [
    new RegExp(
      `from\\s+["']${pkg.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}(?:/[^"']*)?["']`,
      "g",
    ),
    new RegExp(
      `import\\(\\s*["']${pkg.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}(?:/[^"']*)?["']\\s*\\)`,
      "g",
    ),
  ];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const p of patterns) {
      p.lastIndex = 0;
      if (p.test(l)) {
        const prev = i > 0 ? lines[i - 1] : "";
        if (/RENDERER-EXEMPT/.test(prev) || /RENDERER-EXEMPT/.test(l)) continue;
        hits.push({ line: i + 1, raw: l.trim() });
      }
    }
  }
  return hits;
}

describe("ADR-0085 — rendering ownership (runtime mirror of ESLint)", () => {
  // Exclude this test file itself — its regex source and comments would
  // otherwise be flagged as offending imports.
  const SELF = resolve(__dirname, "adr-0085-rendering-ownership.test.ts");
  const files = walk(ROOT).filter((f) => f !== SELF);


  it("no src/** file imports pdf-lib", () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, "utf-8");
      for (const { line, raw } of importedFrom(text, "pdf-lib")) {
        offenders.push(`${relative(ROOT, abs)}:${line}  ${raw}`);
      }
    }
    expect(
      offenders,
      `pdf-lib is banned from src/** (ADR-0085). Route through generate-document + _shared/pdf.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no src/** file imports bwip-js", () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, "utf-8");
      for (const { line, raw } of importedFrom(text, "bwip-js")) {
        offenders.push(`${relative(ROOT, abs)}:${line}  ${raw}`);
      }
    }
    expect(
      offenders,
      `bwip-js is banned from src/** (ADR-0085). Route printable barcodes through printClient.print().\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no src/** file imports the raw `qrcode` package (qrcode.react allowed)", () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, "utf-8");
      // Match `from "qrcode"` or `from "qrcode/<sub>"` only. `qrcode.react`
      // is a different top-level package name and is not matched here.
      const re = /from\s+["']qrcode(\/[^"']*)?["']/g;
      const dyn = /import\(\s*["']qrcode(\/[^"']*)?["']\s*\)/g;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        re.lastIndex = 0;
        dyn.lastIndex = 0;
        if (re.test(l) || dyn.test(l)) {
          const prev = i > 0 ? lines[i - 1] : "";
          if (/RENDERER-EXEMPT/.test(prev) || /RENDERER-EXEMPT/.test(l)) continue;
          offenders.push(`${relative(ROOT, abs)}:${i + 1}  ${l.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `Raw qrcode package is banned from src/** (ADR-0085). Use qrcode.react for on-screen SVG or route printable QRs through printClient.print().\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
