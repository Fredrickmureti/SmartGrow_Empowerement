/**
 * Warehouse layouts must respond to the *container* they render in, not the
 * browser viewport.
 *
 * The workspace shell nests two collapsible panels (app rail + module
 * sidebar) in front of the page, so viewport-keyed breakpoints (`lg:` and
 * friends) fire while the actual content column is still narrow — which is
 * how columns end up constricted and content spills into horizontal scroll.
 * The shell marks the content wrapper `@container/page`, so warehouse layout
 * utilities must use the container variants (`@4xl/page:` …) instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/pages/warehouse", "src/features/warehouse"];
const LAYOUT_UTILS =
  /\b(?:sm|md|lg|xl|2xl):(grid-cols-(?:\d+|none)|col-span-(?:\d+|full)|row-span-(?:\d+|full))\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("warehouse responsive layout", () => {
  it("keys grid layout off the page container, not the viewport", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const hit = line.match(LAYOUT_UTILS);
            if (hit) offenders.push(`${file}:${i + 1} ${hit[0]}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
