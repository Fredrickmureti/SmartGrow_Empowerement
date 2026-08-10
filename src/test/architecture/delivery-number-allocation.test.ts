/**
 * Architecture guard: delivery-note number allocation.
 *
 * Incident 2026-08-10 — confirming an invoice failed with HTTP 409. The
 * business-scoped allocator computed the next number by scanning only rows
 * matching the caller's business, so callers passing a NULL business always
 * got `DN-<year>-0001`, which collided with the
 * (organization_id, business_id, delivery_number) unique index.
 *
 * Invariants protected here:
 *  - the latest allocator definition scans the whole organization for the year,
 *    never `business_id IS NOT DISTINCT FROM` inside the max scan;
 *  - it skips numbers already taken instead of returning a colliding candidate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const migrationDir = "supabase/migrations";

function latestAllocatorDefinition(): string {
  const files = readdirSync(resolve(process.cwd(), migrationDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let latest = "";
  for (const f of files) {
    const sql = readFileSync(resolve(process.cwd(), migrationDir, f), "utf8");
    const idx = sql.lastIndexOf(
      "FUNCTION public.get_next_delivery_number(_org_id uuid, _business_id uuid)",
    );
    if (idx === -1) continue;
    const end = sql.indexOf("$$;", idx);
    latest = sql.slice(idx, end === -1 ? undefined : end + 3);
  }
  return latest;
}

describe("delivery number allocation", () => {
  const def = latestAllocatorDefinition();

  it("has a business-aware allocator defined in migrations", () => {
    expect(def).not.toBe("");
  });

  it("computes the next number org-wide for the year, not per business", () => {
    const maxScan = def.slice(def.indexOf("SELECT COALESCE(MAX("), def.indexOf("LOOP"));
    expect(maxScan).toContain("WHERE organization_id = _org_id");
    expect(maxScan).not.toContain("business_id IS NOT DISTINCT FROM");
  });

  it("never returns a candidate that already exists in the target scope", () => {
    expect(def).toContain("EXIT WHEN NOT EXISTS");
    expect(def).toContain("next_num := next_num + 1");
  });
});
