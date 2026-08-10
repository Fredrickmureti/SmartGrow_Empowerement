/**
 * Architecture guard: the collections escalation ladder ("dunning") is a
 * server-owned policy overlay on canonical AR truth.
 *
 * The invariants protected here:
 *  - `dunning_levels` exists, is org-scoped, RLS-enabled and granted.
 *  - `dunning_assignment` derives the next action from
 *    `finance_ar_net_position` (the canonical projection), never from
 *    `invoices.status`.
 *  - the client service/hook read the view; no client-side level arithmetic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const migrationDir = "supabase/migrations";

function allMigrations(): string {
  return readdirSync(resolve(process.cwd(), migrationDir))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(resolve(process.cwd(), migrationDir, f), "utf8"))
    .join("\n\n");
}

function read(p: string): string {
  return readFileSync(resolve(process.cwd(), p), "utf8");
}

describe("dunning policy architecture", () => {
  const sql = allMigrations();

  it("creates dunning_levels with grants and RLS", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.dunning_levels");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.dunning_levels TO authenticated");
    expect(sql).toContain("GRANT ALL ON public.dunning_levels TO service_role");
    expect(sql).toContain("ALTER TABLE public.dunning_levels ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("is_org_member(auth.uid(), organization_id)");
  });

  it("defines the escalation ladder by days overdue, not by document status", () => {
    expect(sql).toContain("min_days_overdue integer NOT NULL");
    expect(sql).toContain("dunning_action_type");
  });

  it("derives dunning_assignment from the canonical AR net position", () => {
    const idx = sql.indexOf("CREATE OR REPLACE VIEW public.dunning_assignment");
    expect(idx).toBeGreaterThan(-1);
    const body = sql.slice(idx, idx + 2500);
    expect(body).toContain("public.finance_ar_net_position");
    expect(body).toContain("max_days_overdue >= d.min_days_overdue");
    // The view must never read document status tables directly.
    expect(body).not.toMatch(/from\s+public\.invoices/i);
    expect(body).toContain("security_invoker = true");
  });

  it("the client service reads the view and owns no escalation arithmetic", () => {
    const svc = read("src/services/finance/dunning.ts");
    expect(svc).toContain("dunning_assignment");
    expect(svc).not.toMatch(/days_overdue\s*[><]=?\s*\d+/);
    expect(svc).not.toContain("invoices");
  });

  it("Collections renders the next action from the server assignment", () => {
    const page = read("src/pages/sales/Collections.tsx");
    expect(page).toContain("useDunningAssignments");
    expect(page).toContain("Next action");
    expect(page).toContain("DUNNING_ACTION_LABELS");
  });
});
