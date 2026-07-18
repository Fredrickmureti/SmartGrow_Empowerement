/**
 * Architecture guard — Phase 4 (POS reservations single source).
 *
 * `stock_reservations` is the ONLY reservation surface. The legacy
 * `pos_stock_reservations` object — first a table, then a compat view —
 * is fully dropped in Phase 4. No code, no migration, and no test may
 * reintroduce it.
 *
 * Reservation writes from client code must go through the RPCs:
 *   reserve_pos_stock, release_pos_stock_reservation
 *
 * This test complements `stock_reservations` schema-level guards by
 * scanning the entire `src/` tree for stray references and by verifying
 * that no migration after the Phase 4 cutoff recreates the object.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

/** Phase 4 drop cutoff — anything at or after this stamp must not
 * recreate the pos_stock_reservations surface. Updated migrations may
 * still name the identifier when DROPping it. */
const PHASE_4_CUTOFF = "20260719";

function rgOrEmpty(pattern: string, ...paths: string[]): string[] {
  try {
    return execSync(
      `rg -n --no-messages ${JSON.stringify(pattern)} ${paths
        .map((p) => JSON.stringify(p))
        .join(" ")}`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("POS reservations — stock_reservations is the single source (Phase 4)", () => {
  it("no client code queries or writes pos_stock_reservations", () => {
    // Auto-generated types + this test file are allowed to mention the
    // legacy identifier. Everything else must have moved on.
    const ALLOW = new Set([
      "src/integrations/supabase/types.ts",
      "src/test/architecture/pos-reservations-single-source.test.ts",
    ]);
    const hits = rgOrEmpty("pos_stock_reservations", "src")
      .filter((line) => {
        const [file] = line.split(":");
        return !ALLOW.has(file);
      });
    // Comments mentioning the identifier are fine — assert only against
    // supabase-js query-shape lines.
    const offenders = hits.filter(
      (line) =>
        /\.from\(\s*["']pos_stock_reservations["']\s*\)/.test(line) ||
        /\bfrom\s*\(\s*["']pos_stock_reservations["']\s*\)/.test(line),
    );
    expect(offenders, `stray client references:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no migration after the Phase 4 cutoff recreates pos_stock_reservations as a table or view", () => {
    const hits = rgOrEmpty(
      String.raw`CREATE\s+(TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(public\.)?pos_stock_reservations`,
      "supabase/migrations",
    ).filter((line) => {
      const [file] = line.split(":");
      const stamp = file.split("/").pop()?.slice(0, 8) ?? "";
      return stamp >= PHASE_4_CUTOFF;
    });
    expect(hits, `illegal recreation:\n${hits.join("\n")}`).toEqual([]);
  });

  it("reservation RPCs still exist in the migration tree", () => {
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

  it("the shift-close aggregate GL poster has been dropped", () => {
    // A DROP FUNCTION for post_pos_shift_gl exists in the tree. New migrations
    // must not recreate it — per-sale posting (post_pos_sale_gl) plus the
    // variance trigger own GL posting for POS in the new architecture.
    const drops = rgOrEmpty(
      String.raw`DROP\s+FUNCTION\s+(IF\s+EXISTS\s+)?public\.post_pos_shift_gl`,
      "supabase/migrations",
    );
    expect(drops.length, "expected a DROP FUNCTION public.post_pos_shift_gl migration").toBeGreaterThan(0);

    // No CREATE after Phase 4 cutoff.
    const recreated = rgOrEmpty(
      String.raw`CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.post_pos_shift_gl`,
      "supabase/migrations",
    ).filter((line) => {
      const [file] = line.split(":");
      const stamp = file.split("/").pop()?.slice(0, 8) ?? "";
      return stamp >= PHASE_4_CUTOFF;
    });
    expect(recreated, `illegal recreation:\n${recreated.join("\n")}`).toEqual([]);
  });
});
