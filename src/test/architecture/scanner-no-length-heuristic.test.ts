/**
 * Architecture guard — Phase D1 of ADR-0017.
 *
 * The original scan-fragmentation bug came from consumers detecting
 * "this looks like a scan" inside `<BarcodeInputField onChange={...}>`
 * with a `value.length >= N` heuristic. Any 4-character paste fired a
 * fake scan and silently forked scan handling per module.
 *
 * Now that `BarcodeInputField` exposes a router-confirmed `onScan` prop,
 * the heuristic must never come back. This test fails the build if any
 * consumer outside `src/components/scanner/` correlates `onChange` with
 * a string-length check on the same value.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

const EXCLUDE_DIRS = new Set([
  path.join(SRC, "components/scanner"),
  path.join(SRC, "test"),
]);

function walk(dir: string, out: string[] = []): string[] {
  if (EXCLUDE_DIRS.has(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const IMPORTS_BARCODE_FIELD =
  /from\s+["']@\/components\/scanner\/BarcodeInputField["']/;

// Match a length-based scan heuristic anywhere in the file:
//   value.length >= 4
//   code.length > 3
//   scanCode.length >= N
// Constrained to comparisons against numeric literals so unrelated
// `.length` reads (e.g. `lineItems.length === 0`) do not trigger.
const LENGTH_HEURISTIC =
  /\b[A-Za-z_$][\w$]*\.length\s*[><]=?\s*\d+/;

describe("BarcodeInputField — no length-based scan heuristic in consumers", () => {
  it("no consumer outside src/components/scanner/ reacts to onChange via value.length checks", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      if (!IMPORTS_BARCODE_FIELD.test(src)) continue;
      if (!LENGTH_HEURISTIC.test(src)) continue;

      // Narrow further: only flag if the length check sits near an
      // `onChange=` prop (within ~400 chars) — otherwise it's an
      // unrelated array-length read elsewhere in the file.
      const onChangeIdx = src.indexOf("onChange=");
      const lengthMatch = src.match(LENGTH_HEURISTIC);
      if (onChangeIdx < 0 || !lengthMatch) continue;
      const lengthIdx = src.indexOf(lengthMatch[0]);
      if (Math.abs(lengthIdx - onChangeIdx) <= 400) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(
      offenders,
      `These files import BarcodeInputField and use a length-based scan ` +
        `heuristic near onChange=. Use the router-confirmed onScan prop ` +
        `instead (ADR-0017):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});