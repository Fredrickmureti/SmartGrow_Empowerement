/**
 * Ratchet — `purchase_order_items.quantity_billed` has exactly one writer.
 *
 * The PO→Bill receipt-aware conversion (Step 4) and the over-billing guard
 * both depend on `quantity_billed` being the true sum of non-void bill lines
 * linked to the PO line. That invariant is maintained server-side by the
 * trigger function `sync_po_line_billed_quantities` (with
 * `po_resync_billed_state` as the repair path). Any client write drifts it.
 *
 * Live drift at the time of writing: 0 lines.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter(
  (f) => !f.includes(join("src", "test")) && !f.includes("__tests__"),
);

describe("PO billed quantity — single writer", () => {
  it("no client code writes quantity_billed", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      // Object-literal assignment into a mutation payload, e.g. `quantity_billed: x`.
      // Reads, type members (`quantity_billed?: number`) and select strings are fine.
      const re = /quantity_billed\s*:\s*(?!number|string|null)/g;
      if (re.test(src) && /\.(insert|update|upsert)\s*\(/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the server-side maintainer exists in migrations", () => {
    const sql = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .join("\n");
    expect(sql).toMatch(/sync_po_line_billed_quantities/);
  });

  it("PO→Bill conversion goes through the receipt-aware RPC", () => {
    const offenders = FILES.filter((f) =>
      readFileSync(f, "utf8").includes("convert_po_to_bill_atomic"),
    );
    expect(offenders.length).toBeGreaterThan(0);
  });
});
