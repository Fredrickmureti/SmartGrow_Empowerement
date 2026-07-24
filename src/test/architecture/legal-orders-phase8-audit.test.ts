/**
 * ADR-0097 Phase 8 — Legal Orders audit & historical balance architecture pin.
 *
 * Pins the invariants that make the audit + reporting surface correct:
 *
 *   1. Unified timeline view `v_legal_order_audit_timeline` exists and is
 *      declared with `security_invoker = true` (RLS follows the querying
 *      user, not the view creator).
 *   2. Statutory report definitions table exists with GRANT + RLS in the
 *      same migration and partial unique indexes for org and platform
 *      scopes.
 *   3. Point-in-time balance RPC `legal_order_running_balance` is declared
 *      SECURITY DEFINER and gated by `is_org_member`.
 *   4. The Audit tab UI is registered in `LegalOrdersWorkspace` and the
 *      route is mounted in `PayrollRoutes`; the tab surface is READ-ONLY
 *      (no `.update`, `.insert`, or `.delete` calls on any legal-order
 *      table — writes must continue to route through the FSM).
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

describe("legal-orders phase 8 — audit & historical balances", () => {
  const src = allMigrationSrc();

  it("unified audit timeline view is declared with security_invoker", () => {
    expect(
      /CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+(public\.)?v_legal_order_audit_timeline\b[\s\S]*?security_invoker\s*=\s*true/i.test(
        src,
      ),
    ).toBe(true);
  });

  it("statutory report definitions table ships with GRANT + RLS", () => {
    expect(
      /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.legal_order_statutory_report_definitions\b/i.test(
        src,
      ),
    ).toBe(true);
    expect(
      /GRANT[\s\S]{0,120}ON\s+public\.legal_order_statutory_report_definitions[\s\S]{0,60}TO\s+authenticated/i.test(
        src,
      ),
    ).toBe(true);
    expect(
      /ALTER\s+TABLE\s+public\.legal_order_statutory_report_definitions\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(
        src,
      ),
    ).toBe(true);
  });

  it("statutory definitions have both org and platform-scope unique indexes", () => {
    expect(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]{0,200}legal_order_statutory_report_definitions[\s\S]{0,200}organization_id\s+IS\s+NOT\s+NULL/i.test(
        src,
      ),
    ).toBe(true);
    expect(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]{0,200}legal_order_statutory_report_definitions[\s\S]{0,200}organization_id\s+IS\s+NULL/i.test(
        src,
      ),
    ).toBe(true);
  });

  it("legal_order_running_balance is SECURITY DEFINER and org-gated", () => {
    expect(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?legal_order_running_balance\b[\s\S]*?SECURITY\s+DEFINER/i.test(
        src,
      ),
    ).toBe(true);
    // Body must call is_org_member for access enforcement.
    expect(
      /legal_order_running_balance[\s\S]*?is_org_member\s*\(\s*auth\.uid\s*\(\s*\)/i.test(src),
    ).toBe(true);
  });

  it("Audit tab is registered in the workspace and mounted in the router", () => {
    const workspace = readFileSync(
      join(repo, "src/pages/hr/payroll/LegalOrdersWorkspace.tsx"),
      "utf8",
    );
    expect(workspace).toMatch(/legal-orders\/audit/);
    expect(workspace).toMatch(/label:\s*"Audit"/);

    const routes = readFileSync(join(repo, "src/apps/hr/sub/PayrollRoutes.tsx"), "utf8");
    expect(routes).toMatch(/LegalOrdersAudit/);
    expect(routes).toMatch(/path="audit"/);
  });

  it("Audit page is read-only — no writes to legal-order tables from this surface", () => {
    const body = readFileSync(
      join(repo, "src/pages/hr/payroll/LegalOrdersAudit.tsx"),
      "utf8",
    );
    expect(body).not.toMatch(/\.update\s*\(/);
    expect(body).not.toMatch(/\.insert\s*\(/);
    expect(body).not.toMatch(/\.delete\s*\(/);
    // Must consume the projection + RPC by name.
    expect(body).toMatch(/v_legal_order_audit_timeline/);
    expect(body).toMatch(/legal_order_running_balance/);
  });
});
