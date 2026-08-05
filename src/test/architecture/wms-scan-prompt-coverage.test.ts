/**
 * Architecture guard — every "scan the X" prompt runs through the intent engine.
 *
 * An RF screen that renders a bare `<Input placeholder="Scan …">` is a
 * scan prompt that a wedge gun, ring scanner and camera cannot reach: it
 * requires a focused input, skips the identity gate, skips wrong-kind
 * refusal, and skips shared audio/haptic feedback. Scan prompts must be
 * one of the three sanctioned fields:
 *
 *   BinScanField      → positions
 *   ProductScanField  → products
 *   EntityScanField   → LPNs, cartons, manifests, trailers, gate passes
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_SURFACES = [
  join(process.cwd(), "src/pages/warehouse-mobile"),
  join(process.cwd(), "src/apps/warehouse-mobile"),
];

/** The sanctioned fields themselves legitimately render the raw input. */
const SANCTIONED = ["BinScanField", "ProductScanField", "EntityScanField"];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out = out.concat(files(full));
    else if (/\.tsx$/.test(full) && !/\.test\.tsx$/.test(full)) out.push(full);
  }
  return out;
}

describe("WMS scan prompt coverage", () => {
  it("no RF screen renders a bare scan input", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_SURFACES) {
      for (const file of files(dir)) {
        const src = readFileSync(file, "utf8");
        if (SANCTIONED.some((c) => file.includes(c))) continue;
        // A `placeholder="Scan …"` on anything other than a sanctioned field.
        const hasBareScanInput = /placeholder=\{?["'`]\s*Scan[^"'`]*["'`]/i.test(src);
        const usesSanctionedField = SANCTIONED.some((c) => src.includes(`<${c}`));
        if (hasBareScanInput && !usesSanctionedField) {
          offenders.push(file.slice(file.indexOf("src")));
        }
      }
    }
    expect(
      offenders,
      `Scan prompts must use BinScanField / ProductScanField / EntityScanField:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});