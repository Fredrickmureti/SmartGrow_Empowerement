/**
 * Architecture guards for the Employee Portal identity lifecycle.
 *
 * Previous regressions these tests prevent (see .lovable/plan.md
 * "Employee Portal Lifecycle — Re-audit & Fix Plan"):
 *
 *   1. `resolve_my_employee` MUST query `employees.user_id = auth.uid()`
 *      BEFORE consulting `user_roles`. Otherwise a portal user whose
 *      membership row is missing or inactive will be reported as
 *      "not linked" even though `employees.user_id` is set, producing
 *      the "linked yet not linked" contradiction in /me/*.
 *
 *   2. The `employees` table MUST carry a membership-sync trigger so that
 *      writing `employees.user_id` always produces a matching active
 *      `user_roles` row. Without it, `link_employee_to_user` and the
 *      resolver can drift.
 *
 *   3. `useCurrentEmployee` MUST NOT gate calling `resolve_my_employee`
 *      on the client-side org context. The hook's dependency list must
 *      be `[user?.id]` only — adding `currentOrg?.id` would re-introduce
 *      the bailout that hid linked employees.
 *
 *   4. `EmployeeLinkDialog` MUST filter the candidate `user_roles` query
 *      by `is_active = true`. Offering an inactive member as a link
 *      target produces an immediately broken portal state.
 *
 *   5. `v_identity_invariants_violations` MUST be defined and granted to
 *      authenticated/service_role, so it stays usable for live monitoring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function read(rel: string): string {
  const p = join(process.cwd(), rel);
  if (!existsSync(p)) throw new Error(`Expected file missing: ${rel}`);
  return readFileSync(p, "utf-8");
}

// The LATEST migration wins: these objects are `CREATE OR REPLACE`d over time,
// so only the most recent definition describes live behaviour.
function findMigrationContaining(needle: string): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const files = readdirSync(dir).sort().reverse();
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf-8");
    if (body.includes(needle)) return body;
  }
  throw new Error(`No migration contains: ${needle}`);
}

describe("Portal identity invariants", () => {
  describe("Rule 1 — resolver is employee-first", () => {
    const sql = findMigrationContaining(
      "CREATE OR REPLACE FUNCTION public.resolve_my_employee()",
    );

    it("queries employees by user_id BEFORE user_roles", () => {
      const empIdx = sql.search(/FROM public\.employees e\s+WHERE e\.user_id = v_user/);
      const roleIdx = sql.indexOf("FROM public.user_roles");
      expect(empIdx).toBeGreaterThan(-1);
      expect(roleIdx).toBeGreaterThan(-1);
      expect(empIdx).toBeLessThan(roleIdx);
    });

    it("returns is_linked = true based on the employee row, not membership", () => {
      // Tolerate either single or double quotes around the SQL fragments.
      expect(sql).toMatch(/is_linked\s*:?=\s*true/);
    });
  });

  describe("Rule 2 — auto-membership trigger on employees", () => {
    // The trigger and its function can live in different migrations (the
    // function gets replaced later), so each is looked up on its own.
    const triggerSql = findMigrationContaining(
      "CREATE TRIGGER employees_sync_membership_aiu",
    );
    const fnSql = findMigrationContaining(
      "CREATE OR REPLACE FUNCTION public.employees_sync_membership()",
    );

    it("defines the trigger", () => {
      expect(triggerSql).toMatch(/CREATE TRIGGER employees_sync_membership_aiu/);
      expect(triggerSql).toMatch(/AFTER INSERT OR UPDATE OF user_id ON public\.employees/);
    });

    it("upserts user_roles with an active row", () => {
      expect(fnSql).toMatch(/INSERT INTO public\.user_roles[\s\S]+is_active = true/);
    });
  });

  describe("Rule 3 — useCurrentEmployee depends only on user?.id", () => {
    const src = read("src/hooks/useCurrentEmployee.ts");

    it("does not import useOrganization / useBusinesses", () => {
      expect(src).not.toMatch(/from\s+["']\.\/useOrganization["']/);
      expect(src).not.toMatch(/from\s+["']\.\/useBusinesses["']/);
    });

    it("the fetch callback's dependency array is [user?.id]", () => {
      // Match: }, [user?.id]); with possible whitespace.
      expect(src).toMatch(/\},\s*\[user\?\.id\]\s*\)/);
    });

    it("does not early-return on a falsy currentOrg", () => {
      expect(src).not.toMatch(/!currentOrg/);
    });
  });

  describe("Rule 4 — EmployeeLinkDialog filters inactive members", () => {
    const src = read("src/components/employees/EmployeeLinkDialog.tsx");

    it("delegates candidate lookup to the server-side RPC", () => {
      // Wave H F4 moved the candidate query behind a SECURITY DEFINER RPC that
      // gates on hr.write and masks email; the client must not re-query
      // user_roles directly.
      expect(src).toMatch(/get_linkable_users_for_employee/);
      expect(src).not.toMatch(/\.from\(\s*["']user_roles["']\s*\)/);
    });

    it("the RPC itself filters user_roles by is_active = true", () => {
      const rpcSql = findMigrationContaining(
        "get_linkable_users_for_employee",
      );
      expect(rpcSql).toMatch(/ur\.is_active\s*=\s*true/);
    });
  });

  describe("Rule 5 — identity invariants view exists and is granted", () => {
    const sql = findMigrationContaining(
      "v_identity_invariants_violations",
    );

    it("defines the view", () => {
      expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_identity_invariants_violations/);
    });

    it("uses security_invoker", () => {
      expect(sql).toMatch(/security_invoker\s*=\s*true/);
    });

    it("is granted to authenticated and service_role", () => {
      expect(sql).toMatch(/GRANT SELECT ON public\.v_identity_invariants_violations TO authenticated/);
      expect(sql).toMatch(/GRANT SELECT ON public\.v_identity_invariants_violations TO service_role/);
    });

    it("covers the three failure modes", () => {
      expect(sql).toMatch(/linked_employee_missing_active_membership/);
      expect(sql).toMatch(/employee_business_org_mismatch/);
      expect(sql).toMatch(/multiple_employees_for_one_user_in_org/);
    });
  });
});
