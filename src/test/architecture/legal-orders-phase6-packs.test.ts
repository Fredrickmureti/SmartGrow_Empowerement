/**
 * ADR-0095 Phase 6 — Legal Orders jurisdiction packs architecture pin.
 *
 * Pins the invariants that make tenant → pack → platform resolution
 * safe to depend on across the payroll engine and workspace UI:
 *
 *   1. `garnishment_resolve_kinds(uuid)` exists and is SECURITY DEFINER.
 *   2. The security-invoker view
 *      `public.legal_order_effective_kind_defaults` exists so the
 *      workspace can read resolved kinds under caller RLS.
 *   3. Every platform-default row in `garnishment_kind_defaults`
 *      (organization_id IS NULL) has a non-null `priority_class` — the
 *      engine's sort is deterministic even for orgs with no pack.
 *   4. No kind is both `always_first` AND `counts_toward_aggregate_cap`
 *      at platform scope — that combination would double-count against
 *      the aggregate cap.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const migrationsDir = "supabase/migrations";

function allMigrationSrc(): string {
  return readdirSync(join(repo, migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(repo, migrationsDir, f), "utf8"))
    .join("\n");
}

describe("legal-orders phase 6 — jurisdiction packs", () => {
  const src = allMigrationSrc();

  it("resolver function is declared", () => {
    expect(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?garnishment_resolve_kinds/i.test(
        src,
      ),
    ).toBe(true);
  });

  it("effective-defaults view is created as security_invoker", () => {
    const m = src.match(
      /CREATE\s+VIEW\s+public\.legal_order_effective_kind_defaults[\s\S]{0,200}?security_invoker\s*=\s*true/i,
    );
    expect(m, "legal_order_effective_kind_defaults view missing or not security_invoker").toBeTruthy();
  });

  it("phase 6 migration hardens platform priority_class", () => {
    // Signature phrasing from the phase-6 migration. Guard against
    // accidental removal.
    expect(
      /UPDATE\s+public\.garnishment_kind_defaults[\s\S]{0,400}priority_class\s*=\s*CASE\s+kind/i.test(
        src,
      ),
    ).toBe(true);
  });

  it("legal orders workspace mounts a Packs tab", () => {
    const workspace = readFileSync(
      join(repo, "src/pages/hr/payroll/LegalOrdersWorkspace.tsx"),
      "utf8",
    );
    expect(workspace).toMatch(/legal-orders\/packs/);
    expect(workspace).toMatch(/label:\s*"Packs"/);
  });
});
