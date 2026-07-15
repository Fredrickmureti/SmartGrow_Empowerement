// @ts-nocheck — Deno test
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  pivotToMonthlyMatrix,
  applyDerivedColumns,
  projectMonthlyMatrix,
} from "./monthlyMatrix.ts";

Deno.test("pivotToMonthlyMatrix — 12 months, seeded zeros, code sums", () => {
  const rows = [
    { month_index: 1, rule_code: "basic_salary", employee_amount: 100000, employer_amount: 0, taxable_amount: 100000 },
    { month_index: 1, rule_code: "paye_gross", employee_amount: 20000, employer_amount: 0, taxable_amount: 0 },
    { month_index: 2, rule_code: "basic_salary", employee_amount: 100000, employer_amount: 0, taxable_amount: 100000 },
  ];
  const m = pivotToMonthlyMatrix(rows, ["basic_salary", "paye_gross", "shif_employee"]);
  assertEquals(m.length, 12);
  assertEquals(m[0], { month_index: 1, month: 1, basic_salary: 100000, paye_gross: 20000, shif_employee: 0 });
  assertEquals(m[1], { month_index: 2, month: 2, basic_salary: 100000, paye_gross: 0, shif_employee: 0 });
  assertEquals(m[11].basic_salary, 0);
});

Deno.test("pivotToMonthlyMatrix — exposes template-facing month alias", () => {
  const m = pivotToMonthlyMatrix([], ["personal_relief"]);
  assertEquals(m[4].month_index, 5);
  assertEquals(m[4].month, 5);
});

Deno.test("applyDerivedColumns — statutory certificate derived-column formulas", () => {
  const rows = [{
    month_index: 1,
    basic_salary: 100000,
    gross_pay: 120000,
    pension_contribution_actual: 40000,
    ahl_employee: 1800,
    shif_employee: 3300,
    prmf_employee: 0,
    mortgage_interest_relief_base: 0,
    paye_gross: 25000,
    personal_relief: 2400,
    insurance_relief: 0,
  }];
  const derived = [
    { key: "pension_30pct_of_basic", expr: "pct" as const, args: ["basic_salary", 0.30] },
    { key: "pension_statutory_cap", expr: "min" as const, args: ["pension_30pct_of_basic", "pension_contribution_actual", 30000] },
    { key: "total_relief_deductions", expr: "sum" as const, args: ["pension_statutory_cap", "ahl_employee", "shif_employee", "prmf_employee", "mortgage_interest_relief_base"] },
    { key: "chargeable_pay", expr: "sub" as const, args: ["gross_pay", "total_relief_deductions"] },
    { key: "paye_net", expr: "sub" as const, args: ["paye_gross", "personal_relief", "insurance_relief"] },
  ];
  const out = applyDerivedColumns(rows, derived);
  assertEquals(out[0].pension_30pct_of_basic, 30000);
  assertEquals(out[0].pension_statutory_cap, 30000);
  assertEquals(out[0].total_relief_deductions, 30000 + 1800 + 3300);
  assertEquals(out[0].chargeable_pay, 120000 - (30000 + 1800 + 3300));
  assertEquals(out[0].paye_net, 25000 - 2400);
});

Deno.test("projectMonthlyMatrix — end-to-end pivot + derived", () => {
  const rows = [
    { month_index: 3, rule_code: "basic_salary", employee_amount: 50000, employer_amount: 0, taxable_amount: 50000 },
  ];
  const m = projectMonthlyMatrix(rows, ["basic_salary"], [
    { key: "half_basic", expr: "pct", args: ["basic_salary", 0.5] },
  ]);
  assertEquals(m[2].basic_salary, 50000);
  assertEquals(m[2].half_basic, 25000);
  assertEquals(m[0].half_basic, 0);
});
