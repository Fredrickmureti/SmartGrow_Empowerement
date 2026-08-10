/**
 * Architecture guard: collector assignments must be org-scoped, single-active
 * per contact, and managed only through the SECURITY DEFINER RPCs.
 *
 * These tests inspect the migration SQL files to prevent regressions in the
 * table shape, RLS policies, and RPC definitions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const migrationDir = "supabase/migrations";

/** Read all migration files concatenated. */
function allMigrations(): string {
  return readdirSync(resolve(process.cwd(), migrationDir))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(resolve(process.cwd(), migrationDir, f), "utf8"))
    .join("\n\n");
}

describe("collector assignment architecture", () => {
  const sql = allMigrations();

  it("creates the collector_assignments table with correct columns", () => {
    expect(sql).toContain("CREATE TABLE public.collector_assignments");
    expect(sql).toContain("organization_id uuid NOT NULL");
    expect(sql).toContain("contact_id uuid NOT NULL REFERENCES public.contacts");
    expect(sql).toContain("collector_user_id uuid NOT NULL REFERENCES auth.users");
    expect(sql).toContain("active boolean NOT NULL DEFAULT true");
    expect(sql).toContain("assigned_by");
    expect(sql).toContain("deactivated_at");
  });

  it("enables RLS with org-scoped policies", () => {
    expect(sql).toContain("ALTER TABLE public.collector_assignments ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("is_org_member(auth.uid(), organization_id)");
  });

  it("grants to authenticated and service_role", () => {
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.collector_assignments TO authenticated");
    expect(sql).toContain("GRANT ALL ON public.collector_assignments TO service_role");
  });

  it("provides upsert_collector_assignment RPC", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.upsert_collector_assignment");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.upsert_collector_assignment");
  });

  it("upsert deactivates prior assignments before inserting (single-active)", () => {
    const fnDef = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.upsert_collector_assignment"),
      sql.indexOf("GRANT EXECUTE ON FUNCTION public.upsert_collector_assignment"),
    );
    // Must deactivate existing active assignments for the same contact.
    expect(fnDef).toContain("UPDATE public.collector_assignments");
    expect(fnDef).toContain("active = false");
    expect(fnDef).toContain("contact_id = _contact_id AND active = true");
    // Must insert a new active assignment.
    expect(fnDef).toContain("INSERT INTO public.collector_assignments");
  });

  it("provides deactivate_collector_assignment RPC", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.deactivate_collector_assignment");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.deactivate_collector_assignment");
  });

  it("provides fetch RPCs that join auth.users for display names", () => {
    expect(sql).toContain("fetch_collector_assignments_with_names");
    expect(sql).toContain("fetch_org_members");
    // Both must be org-scoped via is_org_member.
    const fetchAssignments = sql.slice(
      sql.indexOf("fetch_collector_assignments_with_names"),
      sql.indexOf("GRANT EXECUTE ON FUNCTION public.fetch_collector_assignments_with_names"),
    );
    expect(fetchAssignments).toContain("is_org_member(auth.uid(), _org_id)");
  });
});
