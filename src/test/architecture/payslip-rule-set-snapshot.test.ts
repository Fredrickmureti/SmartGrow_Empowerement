/**
 * R3 architecture guard — salary structure rule sets.
 *
 * Pins the migration that introduces immutable, versioned snapshots of
 * salary_components so historical payslips remain byte-identical on recompute.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function findMigration(needle: string): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    if (sql.includes(needle)) return sql;
  }
  throw new Error(`No migration found containing: ${needle}`);
}

describe("R3 — salary_structure_rule_sets schema", () => {
  const sql = findMigration("salary_structure_rule_sets");

  it("creates the rule sets table", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.salary_structure_rule_sets/);
    expect(sql).toMatch(/rule_hash TEXT NOT NULL/);
    expect(sql).toMatch(/components JSONB NOT NULL/);
  });

  it("enforces at most one active rule set per structure (partial unique index)", () => {
    expect(sql).toMatch(/uq_salary_rule_set_active_per_structure/);
    expect(sql).toMatch(/WHERE status='active' AND effective_to IS NULL/);
  });

  it("adds rule_set stamp columns to payslips", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS rule_set_id UUID/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS rule_set_version INTEGER/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS rule_set_hash TEXT/);
  });

  it("publishes rule sets via SECURITY DEFINER RPC with stable search_path", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.publish_salary_rule_set/);
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path = public, extensions/);
    // RPC must hash the canonical form (idempotency).
    expect(sql).toMatch(/digest\(v_canonical::text, 'sha256'\)/);
  });

  it("freezes salary_components once any rule set has been published", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.salary_components_freeze_when_used/);
    expect(sql).toMatch(/trg_salary_components_freeze/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.salary_components/);
  });

  it("exposes a resolver that auto-publishes v1 transparently", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_or_publish_rule_set/);
    expect(sql).toMatch(/publish_salary_rule_set\(p_structure_id, p_as_of\)/);
  });

  it("RLS only allows SELECT — writes go through the RPC only", () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY "salary_rule_sets_read".*FOR SELECT/s);
    // No insert/update/delete policy in the migration — guards against drift.
    expect(sql).not.toMatch(/CREATE POLICY[^;]*salary_structure_rule_sets[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i);
  });
});
