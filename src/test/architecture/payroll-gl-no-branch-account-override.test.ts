/**
 * Architecture guard — GL account mapping is HQ / legal-entity authoritative.
 *
 * A branch/store/location never owns GL accounts; it shares the company/entity
 * chart of accounts (mirrors SAP FI, Oracle, Workday, Dynamics 365 F&O). Branch
 * cost attribution is a POSTING DIMENSION on the journal line (`branch_id` /
 * analytic distributions), never a distinct account. This guard fails if a
 * write path starts authoring branch-scoped rows into the mapping surfaces
 * (`default_account_settings` / `default_account_setting_bindings`), which would
 * silently reintroduce the rejected "per-branch chart of accounts" model.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APPLY = readFileSync(
  join(process.cwd(), "supabase", "functions", "apply-default-mappings", "index.ts"),
  "utf8",
);

describe("payroll GL mapping — no branch-scoped account overrides", () => {
  it("apply-default-mappings writes only branch-null mapping rows", () => {
    // The upsert into default_account_settings must pin branch_id to null so a
    // branch can never acquire its own account binding through this path.
    expect(APPLY).toMatch(/branch_id:\s*null/);
  });

  it("apply-default-mappings never writes a non-null branch_id for a mapping", () => {
    // No assignment of a real branch id into the mapping upsert payload.
    expect(APPLY).not.toMatch(/branch_id:\s*(?!null)[A-Za-z_]/);
  });
});
