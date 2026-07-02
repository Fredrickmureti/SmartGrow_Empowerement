/**
 * Pins the contract of the employee-draft lifecycle so a future RLS or
 * persistence refactor can't silently regress privacy or atomicity.
 *
 * Asserted invariants (static, against migrations + source):
 *  1. The drafts RLS policy is RESTRICTIVE and limits SELECT to:
 *       - the draft owner (`draft_owner_id = auth.uid()`)
 *       - the linked user (`user_id = auth.uid()`)
 *       - HR users with `hr.write` permission
 *  2. `create_employee_with_identifiers` defaults `lifecycle_status='active'`
 *     and only stamps `draft_owner_id` when the caller asks for a draft.
 *  3. `finalize_employee_draft` exists, is SECURITY DEFINER, locks the row
 *     FOR UPDATE, validates required fields, and flips status to 'active'
 *     in one transaction — replacing the previous update + promote split.
 *  4. `promote_employee_draft` uses the same permission as creation (hr.create)
 *     so a user who can start an employee can also finish one.
 *  5. `list_employees_paged` / `count_my_employee_drafts` accept the
 *     `p_mine_only` / owner-scoped filter and use `auth.uid()` server-side.
 *  6. The retired per-keystroke autosave hook is gone; the form persists
 *     to the server only on explicit user action.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function readAllMigrations(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n\n");
}

const ALL_SQL = readAllMigrations();
const FORM = readFileSync(
  join(process.cwd(), "src/components/employees/EmployeeFormDialog.tsx"),
  "utf8",
);
const NEW_PAGE = readFileSync(
  join(process.cwd(), "src/pages/hr/EmployeeNewPage.tsx"),
  "utf8",
);

describe("Employee draft lifecycle — security & atomicity invariants", () => {
  it("drafts SELECT policy is RESTRICTIVE and scoped to owner/linked user/hr.write", () => {
    expect(ALL_SQL).toMatch(/POLICY employees_draft_visibility[\s\S]*AS RESTRICTIVE/);
    expect(ALL_SQL).toMatch(/draft_owner_id\s*=\s*auth\.uid\(\)/);
    expect(ALL_SQL).toMatch(/user_id\s*=\s*auth\.uid\(\)/);
    expect(ALL_SQL).toMatch(/user_has_module_permission[\s\S]{0,80}'hr',\s*'write'/);
  });

  it("create_employee_with_identifiers defaults to active and stamps draft_owner_id only for drafts", () => {
    expect(ALL_SQL).toMatch(
      /v_status\s*:=\s*coalesce\(NULLIF\(p_employee->>'lifecycle_status',\s*''\),\s*'active'\)/,
    );
    expect(ALL_SQL).toMatch(/IF v_status = 'draft' THEN[\s\S]*draft_owner_id[\s\S]*ELSE[\s\S]*p_employee - 'draft_owner_id'/);
  });

  it("finalize_employee_draft is single-transaction, validates, and promotes atomically", () => {
    expect(ALL_SQL).toMatch(/FUNCTION public\.finalize_employee_draft/);
    expect(ALL_SQL).toMatch(/SECURITY DEFINER[\s\S]*finalize_employee_draft/);
    expect(ALL_SQL).toMatch(/FROM public\.employees WHERE id = p_employee_id FOR UPDATE/);
    expect(ALL_SQL).toMatch(/first and last name are required to finalize an employee/);
    expect(ALL_SQL).toMatch(/hire date is required to finalize an employee/);
    // Promotion happens in the same UPDATE — no second RPC, no second round-trip.
    expect(ALL_SQL).toMatch(/'active'::text,\s*NULL::uuid,\s*now\(\)/);
  });

  it("promote_employee_draft uses hr.create (same as creation), not hr.write", () => {
    // Most recent CREATE-FUNCTION definition of promote_employee_draft must check hr.create.
    const lastIdx = ALL_SQL.lastIndexOf("CREATE OR REPLACE FUNCTION public.promote_employee_draft");
    expect(lastIdx).toBeGreaterThan(-1);
    const end = ALL_SQL.indexOf("$function$;", lastIdx);
    const body = ALL_SQL.slice(lastIdx, end);
    expect(body).toMatch(/'hr',\s*'create'/);
  });

  it("list_employees_paged supports p_mine_only filtered by auth.uid()", () => {
    expect(ALL_SQL).toMatch(/p_mine_only boolean DEFAULT false/);
    expect(ALL_SQL).toMatch(/NOT p_mine_only OR emp\.draft_owner_id = auth\.uid\(\)/);
  });

  it("count_my_employee_drafts scopes to caller via auth.uid()", () => {
    expect(ALL_SQL).toMatch(/FUNCTION public\.count_my_employee_drafts/);
    expect(ALL_SQL).toMatch(/draft_owner_id = auth\.uid\(\)/);
  });

  it("per-keystroke server autosave is retired", () => {
    expect(existsSync(join(process.cwd(), "src/hooks/hr/useDraftAutosave.ts"))).toBe(false);
    expect(FORM).not.toMatch(/useDraftAutosave/);
    expect(FORM).not.toMatch(/onBlurCapture=\{tryAutoCreateDraft\}/);
  });

  it("EmployeeNewPage uses one atomic finalize call, not update+promote", () => {
    expect(NEW_PAGE).toMatch(/finalize_employee_draft/);
    expect(NEW_PAGE).not.toMatch(/promote_employee_draft/);
    // The dirty baseline advances on save (handled in EmployeeFormDialog).
    expect(FORM).toMatch(/rebaselineDirty/);
  });
});
