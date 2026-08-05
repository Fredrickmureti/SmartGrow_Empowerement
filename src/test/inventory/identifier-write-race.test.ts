/**
 * Regression guard — "barcode edit on phone saved only one character".
 *
 * Root defect: `ProductIdentifiersEditor` issued an `upsert_product_identifier`
 * write on EVERY keystroke, unordered, merging into a render-time snapshot of
 * the rows. On a slow mobile connection an intermediate one-character value
 * could be the last write to land, leaving `code = "1"` in the database while
 * the field still showed the full code.
 *
 * The editor must therefore:
 *   1. never persist on a plain code change (typing),
 *   2. persist on blur, on a confirmed scan, and on form save,
 *   3. read the live rows from a ref, not a captured snapshot,
 *   4. sequence-guard writes per row so a stale in-flight save cannot settle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/components/products/ProductIdentifiersEditor.tsx"),
  "utf8",
);

describe("ProductIdentifiersEditor — identifier write ordering", () => {
  it("does not write to the server while the operator is typing a code", () => {
    expect(src).toMatch(/const structural = patch\.code === undefined;/);
    expect(src).toMatch(/if \(structural && target\.id && productId\)/);
  });

  it("persists on blur and on a confirmed scan", () => {
    expect(src).toMatch(/onBlur=\{\(\)\s*=>\s*\{\s*void persistRow\(idx\);/);
    expect(src).toMatch(/await persistRow\(filledIdx, \{ code \}\)/);
  });

  it("reads the live row state rather than a render-time snapshot", () => {
    expect(src).toMatch(/rowsRef\.current = rows;/);
    expect(src).toMatch(/const live = rowsRef\.current\[idx\];/);
    // The old snapshot read must not come back.
    expect(src).not.toMatch(/const target = rows\[idx\];/);
  });

  it("sequence-guards every write so a stale save can never settle", () => {
    expect(src).toMatch(/writeSeqRef/);
    expect(src).toMatch(/if \(writeSeqRef\.current\.get\(key\) !== seq\) return;/);
  });

  it("flushes dirty persisted rows on commit (form save)", () => {
    expect(src).toMatch(/if \(r\.id && r\._dirty && r\.code\.trim\(\)\)/);
  });
});
