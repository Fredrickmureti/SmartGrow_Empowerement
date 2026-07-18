/**
 * Phase 3 · Batch T3 architecture guard (ADR 0082 D2).
 *
 * POS reservations are unified onto the generic `stock_reservations`
 * table (source_type='pos', source_id=register_id). The legacy
 * `pos_stock_reservations` table is dropped; a compatibility view
 * of the same name remains so historical callers keep reading, but
 * no client code may hand-roll writes into it and the parallel
 * `usePOSStockReservation` hook has been removed.
 *
 * The guards below fail if:
 *   1. the T3 migration is missing (backfill + DROP TABLE + view +
 *      INSTEAD OF DELETE trigger + reserve_pos_stock rewrite),
 *   2. `usePOSStockReservation.ts` reappears or is re-exported,
 *   3. any client file inserts/updates/upserts `pos_stock_reservations`
 *      directly (the view is read-through only; writes must target
 *      `stock_reservations` or the RPCs).
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

function latestMigrationMatching(pattern: string): string {
  const out = execSync(`rg -l ${JSON.stringify(pattern)} supabase/migrations`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error(`no migration matches ${pattern}`);
  return last;
}

describe("POS architecture guard — unified reservations (T3)", () => {
  it("ships the T3 migration: drops the table, creates the compat view + soft-delete trigger, and rewrites reserve_pos_stock", () => {
    const file = latestMigrationMatching("tg_pos_stock_reservations_soft_delete");
    const sql = readFileSync(file, "utf8");
    expect(sql).toMatch(/DROP TABLE public\.pos_stock_reservations/);
    expect(sql).toMatch(/CREATE VIEW public\.pos_stock_reservations/);
    expect(sql).toMatch(/security_invoker\s*=\s*true/);
    expect(sql).toMatch(
      /CREATE TRIGGER trg_pos_stock_reservations_soft_delete[\s\S]*INSTEAD OF DELETE/,
    );
    // reserve_pos_stock now writes stock_reservations (source_type='pos').
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reserve_pos_stock[\s\S]*INSERT INTO public\.stock_reservations[\s\S]*'pos'/,
    );
    // release path is a soft-release on stock_reservations.
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.release_pos_stock_reservation[\s\S]*UPDATE public\.stock_reservations[\s\S]*released_at\s*=\s*now\(\)/,
    );
    // Availability RPCs read stock_reservations.
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_available_pos_stock\b[\s\S]*FROM public\.stock_reservations/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_available_pos_stock_for_register[\s\S]*FROM public\.stock_reservations/,
    );
  });

  it("the parallel usePOSStockReservation hook has been removed and is not re-exported", () => {
    expect(existsSync("src/hooks/pos/usePOSStockReservation.ts")).toBe(false);
    const index = readFileSync("src/hooks/pos/index.ts", "utf8");
    expect(index).not.toMatch(/export\s*\{\s*usePOSStockReservation\s*\}/);
  });

  it("no client file writes to the pos_stock_reservations compat view", () => {
    const ALLOW = [
      /^src\/integrations\/supabase\/types\.ts$/,
      /^src\/test\/architecture\/pos-unified-reservations\.test\.ts$/,
    ];
    const files = execSync(
      'rg --files-with-matches "pos_stock_reservations" src/ || true',
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((p) => !ALLOW.some((re) => re.test(p)));

    const offenders: string[] = [];
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      const re =
        /\bfrom\s*\(\s*["']pos_stock_reservations["']\s*\)[\s\S]{0,400}?\.(insert|update|upsert|delete)\s*\(/;
      if (re.test(stripped)) offenders.push(p);
    }
    expect(
      offenders,
      `Client files writing pos_stock_reservations directly:\n${offenders.join("\n")}\n` +
        "Use reserve_pos_stock / release_pos_stock_reservation RPCs, which target stock_reservations.",
    ).toEqual([]);
  });
});
