/**
 * Architecture guard — Product Detail surfaces must keep hook order stable.
 *
 * Regression of: "Rendered more hooks than during the previous render."
 * Root cause was an `if (!product) return null;` placed BEFORE a later
 * `useQtyFormatter(...)` call in ProductDetailDialog.tsx. We forbid any
 * `useX(...)` call after an early `return` in product-detail files.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/components/products/detail"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe("product detail — hook order invariants", () => {
  it("no use*() hook call appears after an early return null", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        const lines = src.split("\n");
        // Track per-function: index of first `return null` or `return <Foo` after
        // hook calls, then flag any subsequent `use...(` on that file.
        let sawReturn = false;
        let returnLine = -1;
        lines.forEach((line, i) => {
          const trimmed = line.trim();
          if (!sawReturn && /^return\s+(null|<)/.test(trimmed)) {
            sawReturn = true;
            returnLine = i + 1;
          } else if (sawReturn && /\buse[A-Z]\w*\s*\(/.test(line)) {
            offenders.push(`${file}:${i + 1} — use*() after return at line ${returnLine}`);
          }
        });
      }
    }
    expect(
      offenders,
      `Hook calls must precede every early return. Move the hook to the top of ` +
        `the component body and gate its arguments instead.\n\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});