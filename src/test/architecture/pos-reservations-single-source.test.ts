/**
 * Architecture guard — Phase 3 · Batch T7 (reservations single source).
 *
 * `stock_reservations` is the ONLY writable reservation table. The old
 * `pos_stock_reservations` is a read-through compatibility view with an
 * INSTEAD OF DELETE trigger for legacy readers — no client code may
 * INSERT / UPDATE / UPSERT it, and no new migration may re-create it as
 * a table.
 *
 * Reservation writes from client code must go through the RPCs:
 *   reserve_pos_stock, release_pos_stock_reservation
 *
 * Complements `pos-unified-reservations.test.ts` by scanning the entire
 * `src/` tree (not just hook exports) for stray writes.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

function rgOrEmpty(pattern: string, ...paths: string[]): string[] {
  try {
    return execSync(
      `rg -n --no-messages ${JSON.stringify(pattern)} ${paths.map((p) => JSON.stringify(p)).join(" ")}`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("POS reservations — stock_reservations is the single source", () => {
  it("no client-side writes into pos_stock_reservations", () => {
    // Any line that both mentions the table name AND performs a
    // write-shaped supabase-js call. rg pattern intentionally avoids
    // backticks so bash JSON quoting stays valid.
    const candidates = rgOrEmpty("pos_stock_reservations", "src");
    const hits = candidates.filter((line) =>
      /\.(insert|update|upsert|delete)\s*\(/.test(line),
    );
    expect(hits, `stray writes:\n${hits.join("\n")}`).toEqual([]);
  });

  it("no migration recreates pos_stock_reservations as a table", () => {
    const hits = rgOrEmpty(
      String.raw`CREATE\s+TABLE\s+(public\.)?pos_stock_reservations`,
      "supabase/migrations",
    ).filter((line) => {
      // The original T3 migration DROPs then recreates as a VIEW — that's
      // fine. Fail only on future migrations that resurrect it as a table.
      const [file] = line.split(":");
      // The historical create-as-table migrations pre-date the T3 unification
      // and remain in the tree by design; skip anything before the T3 batch.
      const stamp = file.split("/").pop()?.slice(0, 8) ?? "";
      return stamp >= "20260718"; // T3 shipped on / after this date
    });
    expect(hits, `illegal recreation:\n${hits.join("\n")}`).toEqual([]);
  });

  it("reservation RPCs exist in the migration tree", () => {
    expect(
      rgOrEmpty(
        "CREATE OR REPLACE FUNCTION public.reserve_pos_stock",
        "supabase/migrations",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      rgOrEmpty(
        "CREATE OR REPLACE FUNCTION public.release_pos_stock_reservation",
        "supabase/migrations",
      ).length,
    ).toBeGreaterThan(0);
  });
});