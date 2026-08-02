/**
 * Architecture guard — location identity has exactly one resolver seam.
 *
 * A scanned bin label must always go through `resolve_location_identity`
 * (ADR 0104). Two failure modes this test exists to prevent:
 *
 *  1. A surface querying `stock_locations` by `barcode` directly — that
 *     bypasses tenant scoping and silently picks a winner when two
 *     warehouses share a code.
 *  2. An operator screen confirming a position by string-comparing typed
 *     input against `location.code` — that ignores the printed barcode
 *     entirely, so a correctly-labelled bin reads as "wrong bin".
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/pages", "src/features", "src/components", "src/hooks"];
const RESOLVER = "src/features/warehouse/locations/useResolveLocationIdentity.ts";

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r)).filter((f) => !f.endsWith(RESOLVER));

describe("wms location identity — single seam", () => {
  it("no surface queries stock_locations by barcode", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (!src.includes('from("stock_locations")') && !src.includes("from('stock_locations')")) {
        return false;
      }
      return /\.eq\(\s*["']barcode["']/.test(src) || /\.ilike\(\s*["']barcode["']/.test(src);
    });
    expect(offenders, `Use useResolveLocationIdentity instead:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  it("operator screens do not confirm a bin by comparing typed text to a code", () => {
    const mobile = files.filter((f) => f.includes("warehouse-mobile"));
    const offenders = mobile.filter((f) => {
      const src = readFileSync(f, "utf8");
      // e.g. binScan.trim().toLowerCase() !== expectedBin
      return /bin[A-Za-z]*\s*\.trim\(\)\s*\.toLowerCase\(\)\s*[!=]==/.test(src);
    });
    expect(
      offenders,
      `Use BinScanField / useResolveLocationIdentity instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
