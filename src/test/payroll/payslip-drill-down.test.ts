/**
 * Phase 4 P4 — unit tests for the drill-down resolver.
 *
 * Verifies the country-agnostic invariant (no statutory vocabulary
 * leaks into a URL), that every `InputRefKind` resolves to a non-null
 * target in at least one context, and that sensitive kinds stay
 * admin-only.
 */
import { describe, it, expect } from "vitest";
import {
  resolveDrillTarget,
  COUNTRY_SPECIFIC_TOKEN_RE,
  labelFor,
} from "@/lib/payroll/payslipDrillDown";
import type { InputRef, InputRefKind } from "@/lib/payroll/inputRef";

const ALL_KINDS: InputRefKind[] = [
  "contract",
  "salary_structure",
  "payslip_input",
  "variable_input",
  "work_entry",
  "attendance",
  "leave_request",
  "loan",
  "garnishment",
  "statutory_rule",
  "retro",
  "expense",
  "reimbursement",
  "benefit",
  "termination_payout",
  "override",
];

/** Maximal sample ref per kind — every optional id populated. */
function sampleRef(kind: InputRefKind): InputRef {
  const base: any = { kind };
  switch (kind) {
    case "contract":
      return { ...base, contract_id: "c-1", component: "basic" };
    case "salary_structure":
      return { ...base, structure_id: "s-1", component_id: "comp-1" };
    case "payslip_input":
    case "variable_input":
      return { ...base, input_type_id: "it-1", payslip_input_id: "pi-1" };
    case "work_entry":
    case "attendance":
      return { ...base, work_entry_id: "we-1", date: "2026-06-01", hours: 8 };
    case "leave_request":
      return { ...base, leave_request_id: "lr-1", days: 2 };
    case "loan":
      return { ...base, loan_id: "ln-1", installment_no: 3 };
    case "garnishment":
      return { ...base, garnishment_id: "g-1" };
    case "statutory_rule":
      return {
        ...base,
        statutory_rule_id: "sr-1",
        pack_version_id: "pv-1",
        rule_code: "GENERIC",
      };
    case "retro":
      return { ...base, source_payslip_id: "ps-old", source_run_id: "run-old" };
    case "expense":
    case "reimbursement":
      return { ...base, expense_id: "e-1" };
    case "benefit":
      return { ...base, benefit_id: "b-1", plan_id: "p-1" };
    case "termination_payout":
      return { ...base, pending_payout_id: "tp-1", days: 14 };
    case "override":
      return { ...base, reason: "Manager fix" };
  }
}

describe("resolveDrillTarget — country-agnostic invariant", () => {
  it("never emits a URL containing statutory vocabulary", () => {
    for (const kind of ALL_KINDS) {
      const ref = sampleRef(kind);
      for (const mode of ["admin", "portal"] as const) {
        const t = resolveDrillTarget(ref, { mode, employeeId: "emp-1" });
        if (!t) continue;
        expect(t.href).not.toMatch(COUNTRY_SPECIFIC_TOKEN_RE);
        expect(t.label).not.toMatch(COUNTRY_SPECIFIC_TOKEN_RE);
      }
    }
  });

  it("every non-override kind resolves in at least one context", () => {
    const unresolved: InputRefKind[] = [];
    for (const kind of ALL_KINDS) {
      if (kind === "override") continue;
      const ref = sampleRef(kind);
      const admin = resolveDrillTarget(ref, { mode: "admin", employeeId: "emp-1" });
      const portal = resolveDrillTarget(ref, { mode: "portal", employeeId: "emp-1" });
      if (!admin && !portal) unresolved.push(kind);
    }
    expect(unresolved).toEqual([]);
  });

  it("override always resolves to null", () => {
    expect(resolveDrillTarget(sampleRef("override"), { mode: "admin" })).toBeNull();
    expect(resolveDrillTarget(sampleRef("override"), { mode: "portal" })).toBeNull();
  });
});

describe("resolveDrillTarget — sensitivity & scoping", () => {
  it.each([
    "garnishment",
    "statutory_rule",
    "termination_payout",
    "salary_structure",
    "benefit",
  ] as const)("sensitive kind %s never exposes a portal route", (kind) => {
    const t = resolveDrillTarget(sampleRef(kind as InputRefKind), {
      mode: "portal",
      employeeId: "emp-1",
    });
    expect(t).toBeNull();
  });

  it("admin URLs sit under /hr/ or top-level finance/expenses surfaces", () => {
    for (const kind of ALL_KINDS) {
      const t = resolveDrillTarget(sampleRef(kind), {
        mode: "admin",
        employeeId: "emp-1",
      });
      if (!t) continue;
      expect(t.href.startsWith("/hr/") || t.href.startsWith("/expenses")).toBe(true);
    }
  });

  it("portal URLs always sit under /me/", () => {
    for (const kind of ALL_KINDS) {
      const t = resolveDrillTarget(sampleRef(kind), {
        mode: "portal",
        employeeId: "emp-1",
      });
      if (!t) continue;
      expect(t.href.startsWith("/me/")).toBe(true);
    }
  });

  it("returns null when required identifiers are missing", () => {
    expect(
      resolveDrillTarget({ kind: "loan" }, { mode: "admin" }),
    ).toBeNull();
    expect(
      resolveDrillTarget({ kind: "leave_request" }, { mode: "portal" }),
    ).toBeNull();
    expect(
      resolveDrillTarget(
        { kind: "contract", contract_id: "c-1" },
        { mode: "admin" /* no employeeId */ },
      ),
    ).toBeNull();
  });

  it("requiresPermission is set on every admin target", () => {
    for (const kind of ALL_KINDS) {
      const t = resolveDrillTarget(sampleRef(kind), {
        mode: "admin",
        employeeId: "emp-1",
      });
      if (!t) continue;
      expect(t.requiresPermission).toBeTruthy();
    }
  });

  it("portal targets do not require an admin permission", () => {
    for (const kind of ALL_KINDS) {
      const t = resolveDrillTarget(sampleRef(kind), {
        mode: "portal",
        employeeId: "emp-1",
      });
      if (!t) continue;
      expect(t.requiresPermission).toBeUndefined();
    }
  });
});

describe("labelFor", () => {
  it("returns a non-empty label for every navigable kind", () => {
    for (const kind of ALL_KINDS) {
      if (kind === "override") {
        expect(labelFor(kind)).toBe("");
        continue;
      }
      expect(labelFor(kind).length).toBeGreaterThan(0);
    }
  });

  it("labels themselves stay country-agnostic", () => {
    for (const kind of ALL_KINDS) {
      expect(labelFor(kind)).not.toMatch(COUNTRY_SPECIFIC_TOKEN_RE);
    }
  });
});
