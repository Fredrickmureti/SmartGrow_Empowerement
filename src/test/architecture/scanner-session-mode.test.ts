// Stage 5 architecture guard (POS scanner re-audit):
// Any onboarding-style consumer of <ScannerSessionDialog> MUST use
// mode="persistent" so the scanner channel survives dialog close.
//
// Onboarding-style consumers are anything under:
//   - src/components/products/
//   - src/features/<x>/onboarding/
//   - src/pages/<x>/onboarding/
//
// Modal-only callers (POS receiving, ad-hoc pairing buttons) keep the
// default behavior — they explicitly want the session torn down on close.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

const ONBOARDING_GLOBS = [
  /\/components\/products\//,
  /\/features\/.*\/onboarding\//,
  /\/pages\/.*\/onboarding\//,
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const n of entries) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const full = path.join(dir, n);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n)) out.push(full);
  }
  return out;
}

describe("scanner-session mode discipline", () => {
  const files = walk(SRC).filter((f) =>
    ONBOARDING_GLOBS.some((g) => g.test(f.replace(/\\/g, "/"))),
  );

  it("locates onboarding files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every onboarding ScannerSessionDialog uses mode=\"persistent\"", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Find each <ScannerSessionDialog ... /> JSX (greedy across newlines).
      const matches = src.match(/<ScannerSessionDialog\b[\s\S]*?\/>/g) || [];
      for (const m of matches) {
        if (!/mode\s*=\s*["']persistent["']/.test(m)) {
          offenders.push(path.relative(process.cwd(), f));
          break;
        }
      }
    }
    expect(
      offenders,
      `These onboarding files must pass mode="persistent" to <ScannerSessionDialog>:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
