/**
 * Architectural guardrail — Statutory Rules ↔ Custom Deduction Types
 * separation (Phase C of the Statutory Rules legislative-cockpit work).
 *
 * Statutory Rules is the platform's *legislative* surface: it is pack-owned,
 * effective-dated, and governed by the upgrade/conflict/audit pipeline.
 *
 * Custom Deduction Types is the *operational* surface: it is tenant-owned,
 * has no pack lifecycle, and exists so workspaces can describe non-statutory
 * shapes (loans, SACCO, gym fees).
 *
 * Co-locating both under one screen previously hid that distinction (W8).
 * This test pins the separation so a future refactor cannot collapse them
 * back into a single workspace without an explicit decision + ADR update.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const statutoryPage = readFileSync(
  resolve(__dirname, "../../pages/hr/PayrollStatutoryRules.tsx"),
  "utf8",
);
const deductionTypesPage = readFileSync(
  resolve(__dirname, "../../pages/hr/payroll/CustomDeductionTypes.tsx"),
  "utf8",
);
const payrollRoutes = readFileSync(
  resolve(__dirname, "../../apps/hr/sub/PayrollRoutes.tsx"),
  "utf8",
);
const navs = readFileSync(
  resolve(__dirname, "../../apps/hr/shared/navs.ts"),
  "utf8",
);

describe("statutory rules ↔ custom deduction types — IA separation", () => {
  it("Statutory Rules page does not author custom deduction *types*", () => {
    // It may still *read* tenant rule-type codes to label the rule-editor
    // type picker (round-trip for legacy rows), but it must not embed the
    // type creation/edit/delete UI or mutations.
    expect(statutoryPage).not.toMatch(/RuleTypeFormDialog/);
    expect(statutoryPage).not.toMatch(/deleteTypeMutation/);
    expect(statutoryPage).not.toMatch(/setShowTypeDialog/);
    expect(statutoryPage).not.toMatch(/<TabsTrigger value="types"/);
    expect(statutoryPage).not.toMatch(/<TabsContent value="types"/);
  });

  it("Custom Deduction Types lives at its own route", () => {
    expect(payrollRoutes).toMatch(/configuration\/deduction-types/);
    expect(payrollRoutes).toMatch(/CustomDeductionTypes/);
    expect(navs).toMatch(/configuration\/deduction-types/);
  });

  it("Custom Deduction Types page does NOT author statutory rules", () => {
    // Tenant-owned operational surface: it must never write to the
    // pack-governed payroll_statutory_rules table or open the engine-driven
    // StatutoryRuleEditor. Doing so would re-introduce the IA muddle.
    expect(deductionTypesPage).not.toMatch(/payroll_statutory_rules/);
    expect(deductionTypesPage).not.toMatch(/StatutoryRuleEditor/);
    expect(deductionTypesPage).not.toMatch(/UpgradeInboxPanel|ConflictsPanel|TimelinePanel/);
  });

  it("Statutory Rules retains its legislative cockpit surfaces", () => {
    // Provenance, downstream impact, upgrades, conflicts, timeline, audit
    // — these must stay on the legislative workspace.
    expect(statutoryPage).toMatch(/StatutoryRuleWorkspaceHeader/);
    expect(statutoryPage).toMatch(/StatutoryRuleProvenanceBadge/);
    expect(statutoryPage).toMatch(/StatutoryRuleConsumersDrawer/);
    expect(statutoryPage).toMatch(/UpgradeInboxPanel/);
    expect(statutoryPage).toMatch(/ConflictsPanel/);
    expect(statutoryPage).toMatch(/TimelinePanel/);
    expect(statutoryPage).toMatch(/AuditPanel/);
  });

  it("Shared rule-type hook lives in one place", () => {
    // useRuleTypes must NOT be redeclared inside page modules — both pages
    // import it from the shared hooks file.
    expect(statutoryPage).toMatch(/from "@\/hooks\/usePayrollRuleTypes"/);
    expect(deductionTypesPage).toMatch(/from "@\/hooks\/usePayrollRuleTypes"/);
    expect(statutoryPage).not.toMatch(/function useRuleTypes\(/);
    expect(deductionTypesPage).not.toMatch(/function useRuleTypes\(/);
  });
});
