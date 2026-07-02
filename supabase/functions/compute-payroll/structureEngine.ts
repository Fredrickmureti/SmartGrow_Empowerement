/**
 * Stage D — Salary structure graph engine (Odoo-parity, country-agnostic).
 *
 * Pure, deterministic module. Given (rules, payroll context, work entries
 * grouped by type), walks the rule graph in `sequence` order, evaluates each
 * rule's condition + amount, and returns payslip line rows.
 *
 * Selection happens upstream in `index.ts`: only invoked when
 * `salary_structures.use_structure_engine = true` AND the structure has at
 * least one `payroll_salary_rules` row in its current rule-set snapshot.
 * Legacy `salary_components` walk remains untouched for everyone else.
 *
 * NEVER reads from the DB directly — caller passes the rule snapshot, so
 * recomputation against historical payslips is byte-identical (the snapshot
 * lives in `salary_structure_rule_sets.components`).
 */

import { evaluateExpression, RuleExpressionError, type PayrollContext } from "./expressionEngine.ts";

export interface SalaryRule {
  id: string;
  code: string;
  name: string;
  sequence: number;
  category: "basic" | "allowance" | "deduction" | "employer_contribution" | "net" | "gross" | "other";
  parent_rule_id: string | null;
  condition_select: "always" | "expression";
  condition_expression: string | null;
  amount_select: "fixed" | "percentage" | "expression" | "statutory_ref";
  amount_fixed: number | null;
  amount_percentage: number | null;
  amount_base: string | null;            // "BASIC" | "GROSS" | "TAXABLE" | "<rule_code>"
  amount_expression: string | null;
  statutory_rule_id: string | null;
  appears_on_payslip: boolean;
  accounting_debit_account_id: string | null;
  accounting_credit_account_id: string | null;
  accounting_tag: string | null;
  is_active: boolean;
}

export interface WorkEntryType {
  id: string;
  code: string;
  is_paid: boolean;
  counts_as_worked: boolean;
  multiplier_normal: number;
  multiplier_overtime: number;
}

export interface WorkEntryRow {
  work_entry_type_id: string | null;
  hours: number;
  overtime_hours: number;
  /** Days, derived if available; otherwise hours / 8. */
  days?: number;
}

export interface PayslipLine {
  rule_id: string;
  code: string;
  name: string;
  category: string;
  sequence: number;
  amount: number;
  appears_on_payslip: boolean;
  accounting_debit_account_id: string | null;
  accounting_credit_account_id: string | null;
  accounting_tag: string | null;
}

export interface StructureEngineInput {
  rules: SalaryRule[];
  workEntryTypes: WorkEntryType[];
  workEntries: WorkEntryRow[];
  employee: PayrollContext["employee"];
  contract: PayrollContext["contract"];
  /** Optional resolver for `statutory_ref` rules — usually delegates to the legacy statutory engine. */
  statutoryResolver?: (statutoryRuleId: string, ctx: PayrollContext) => number;
}

export interface StructureEngineResult {
  lines: PayslipLine[];
  totals: { gross: number; deductions: number; employer: number; net: number; basic: number; taxable: number };
  errors: { rule_code: string; message: string; offset?: number }[];
}

export class StructureEngineError extends Error {
  constructor(message: string, public code: string, public ruleCode?: string) {
    super(message);
  }
}

// ─── Work entry aggregation ──────────────────────────────────────────────

export function aggregateWorkedHours(
  entries: WorkEntryRow[],
  types: WorkEntryType[],
): { worked_hours: Record<string, number>; worked_days: Record<string, number> } {
  const byId = new Map(types.map((t) => [t.id, t]));
  const worked_hours: Record<string, number> = {};
  const worked_days: Record<string, number> = {};
  for (const e of entries) {
    if (!e.work_entry_type_id) continue;
    const t = byId.get(e.work_entry_type_id);
    if (!t) continue;
    // Unpaid leave zeroes out (is_paid=false): no contribution to worked hours.
    if (!t.is_paid) continue;
    const normal = (e.hours || 0) * (t.multiplier_normal ?? 1);
    const ot = (e.overtime_hours || 0) * (t.multiplier_overtime ?? 1.5);
    worked_hours[t.code] = (worked_hours[t.code] ?? 0) + normal + ot;
    const days = e.days ?? ((e.hours || 0) / 8);
    worked_days[t.code] = (worked_days[t.code] ?? 0) + days;
  }
  return { worked_hours, worked_days };
}

// ─── Rule walk ───────────────────────────────────────────────────────────

function resolveBase(base: string | null, ctx: PayrollContext, results: Record<string, number>): number {
  if (!base) return 0;
  if (base === "BASIC") return ctx.BASIC;
  if (base === "GROSS") return ctx.GROSS;
  if (base === "TAXABLE") return ctx.TAXABLE;
  if (base === "NET") return ctx.NET;
  return results[base] ?? 0;
}

export function runStructureEngine(input: StructureEngineInput): StructureEngineResult {
  const { rules, workEntryTypes, workEntries, employee, contract, statutoryResolver } = input;

  const { worked_hours, worked_days } = aggregateWorkedHours(workEntries, workEntryTypes);

  const results: Record<string, number> = {};
  const lines: PayslipLine[] = [];
  const errors: StructureEngineResult["errors"] = [];
  let basic = 0, gross = 0, taxable = 0, deductions = 0, employer = 0;

  // Sort by sequence (parent ordering is the editor's responsibility).
  const sorted = rules.filter((r) => r.is_active).sort((a, b) => a.sequence - b.sequence);

  for (const rule of sorted) {
    const ctx: PayrollContext = {
      BASIC: basic,
      GROSS: gross,
      TAXABLE: taxable,
      NET: gross - deductions,
      employee,
      contract,
      worked_hours,
      worked_days,
      result: results,
    };

    // Condition
    try {
      if (rule.condition_select === "expression" && rule.condition_expression) {
        const passed = evaluateExpression(rule.condition_expression, ctx);
        if (!passed) {
          results[rule.code] = 0;
          continue;
        }
      }
    } catch (e) {
      const re = e instanceof RuleExpressionError ? e : null;
      errors.push({ rule_code: rule.code, message: `condition: ${(e as Error).message}`, offset: re?.offset });
      continue;
    }

    // Amount
    let amount = 0;
    try {
      switch (rule.amount_select) {
        case "fixed":
          amount = rule.amount_fixed ?? 0;
          break;
        case "percentage": {
          const base = resolveBase(rule.amount_base, ctx, results);
          amount = base * ((rule.amount_percentage ?? 0) / 100);
          break;
        }
        case "expression":
          amount = Number(evaluateExpression(rule.amount_expression ?? "0", ctx)) || 0;
          break;
        case "statutory_ref":
          if (!rule.statutory_rule_id || !statutoryResolver) {
            errors.push({ rule_code: rule.code, message: "statutory_ref rule missing resolver or rule_id" });
            continue;
          }
          amount = statutoryResolver(rule.statutory_rule_id, ctx);
          break;
      }
    } catch (e) {
      const re = e instanceof RuleExpressionError ? e : null;
      errors.push({ rule_code: rule.code, message: `amount: ${(e as Error).message}`, offset: re?.offset });
      continue;
    }

    // Round to 2 dp
    amount = Math.round(amount * 100) / 100;
    results[rule.code] = amount;

    // Update running totals by category (Odoo semantics)
    if (rule.category === "basic") basic += amount;
    if (rule.category === "basic" || rule.category === "allowance") {
      gross += amount;
      taxable += amount;
    }
    if (rule.category === "deduction") deductions += amount;
    if (rule.category === "employer_contribution") employer += amount;
    // gross/net categories are aggregates; we don't add them again

    lines.push({
      rule_id: rule.id,
      code: rule.code,
      name: rule.name,
      category: rule.category,
      sequence: rule.sequence,
      amount,
      appears_on_payslip: rule.appears_on_payslip,
      accounting_debit_account_id: rule.accounting_debit_account_id,
      accounting_credit_account_id: rule.accounting_credit_account_id,
      accounting_tag: rule.accounting_tag,
    });
  }

  return {
    lines,
    totals: { gross, deductions, employer, net: gross - deductions, basic, taxable },
    errors,
  };
}
