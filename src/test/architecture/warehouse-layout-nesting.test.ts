/**
 * Guard: `Section` is already a card (border + surface + padding). Nesting a
 * `Card` directly inside one produces the double-container look operators
 * reported on phones — box inside box inside box, with the inner content
 * squeezed by two sets of gutters.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/pages/warehouse", "src/features/warehouse", "src/pages/warehouse-mobile"];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("warehouse layout nesting", () => {
  it("never wraps a Card directly inside a Section", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        if (/<Section[^>]*>\s*<Card[\s>]/.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
