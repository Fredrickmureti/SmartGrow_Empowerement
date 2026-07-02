/**
 * Architecture guard: the canonical source of truth for any product barcode
 * is `product_identifiers`. No non-test, non-schema source file may read or
 * query a `barcode` column on the products table at runtime.
 *
 * This test catches:
 *   - SQL like `SELECT ... FROM products WHERE ... barcode ...`
 *   - PostgREST-style `.from("products").select("...barcode...")`
 *   - JS member access `products.barcode` / `product.barcode`
 *
 * Allowlist: the Electron SQLite schema definitions (column + index) are
 * kept for backward-compat with older local caches, but they must never be
 * QUERIED. The schema files appear in ALLOW; query sites must not appear
 * anywhere outside this allowlist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "electron"),
];

// Files allowed to mention `barcode` near `products` (schema definitions,
// the comment in SQLiteBridge, this guard itself, etc.).
const ALLOW = new Set([
  path.join(REPO_ROOT, "electron/database/DatabaseManager.ts"),
  path.join(REPO_ROOT, "electron/database/DatabaseManager.js"),
  path.join(REPO_ROOT, "src/services/offline/SQLiteBridge.ts"),
  path.join(REPO_ROOT, "src/test/architecture/no-legacy-products-barcode.test.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist" || name === "build") continue;
    const full = path.join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const FORBIDDEN_PATTERNS: RegExp[] = [
  // PostgREST equality / filter on the legacy column
  /\.(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|or)\(\s*['"`][^'"`]*\bbarcode\b/,
  // SQL inside a template literal that selects/filters barcode from products
  /\bSELECT\b[\s\S]{0,400}?\bbarcode\b[\s\S]{0,400}?\bFROM\s+products\b/i,
  /\bFROM\s+products\b[\s\S]{0,400}?\bbarcode\b/i,
  // JS member access on a single product row (NOT function names like getProductByBarcode)
  /(?<![A-Za-z0-9_])products?\.barcode\b/,
];


describe("legacy products.barcode runtime reads are retired", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(r, files);

  it("scans some source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no non-allowlisted file references products.barcode at runtime", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOW.has(f)) continue;
      const src = readFileSync(f, "utf8");
      if (FORBIDDEN_PATTERNS.some((re) => re.test(src))) {
        offenders.push(path.relative(REPO_ROOT, f));
      }
    }
    expect(
      offenders,
      `These files still read the legacy products.barcode column. Move to product_identifiers:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
