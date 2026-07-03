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

import { evaluateExpression, extractIdentifiers, RuleExpressionError, type PayrollContext } from "./expressionEngine.ts";

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

/**
 * Phase 3 — Per-expression provenance trace.
 *
 * When callers pass a `traceSink`, `runStructureEngine` records one row
 * per rule it evaluates capturing exactly which expression fired, which
 * base/context bindings it saw, and the resolved amount. The trace is
 * additive (no engine-behaviour change) and lets the historical
 * simulator + audit UI reproduce per-line math without re-running the
 * whole engine speculatively.
 *
 * `dependencies` is the list of top-level identifiers the expression
 * referenced (extracted from the AST via `extractIdentifiers`), same
 * source of truth the cycle detector uses. Downstream tools can build a
 * DAG visualisation from this without re-parsing.
 */
export interface StructureRuleTrace {
  rule_id: string;
  rule_code: string;
  sequence: number;
  category: string;
  condition_expression: string | null;
  condition_passed: boolean;
  amount_select: SalaryRule["amount_select"];
  amount_expression: string | null;
  amount_base: string | null;
  base_value: number;
  dependencies: string[];
  resolved_amount: number;
  error: string | null;
}

export interface StructureEngineInput {
  rules: SalaryRule[];
  workEntryTypes: WorkEntryType[];
  workEntries: WorkEntryRow[];
  employee: PayrollContext["employee"];
  contract: PayrollContext["contract"];
  /** Optional resolver for `statutory_ref` rules — usually delegates to the legacy statutory engine. */
  statutoryResolver?: (statutoryRuleId: string, ctx: PayrollContext) => number;
  /** Optional per-rule provenance trace. Additive; caller owns storage. */
  traceSink?: StructureRuleTrace[];
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

// ─── Phase 3 — Dependency graph + cycle detection ─────────────────────────

/** Identifiers that are BUILT-IN running totals, not sibling rule codes. */
const BUILTIN_BASES = new Set(["BASIC", "GROSS", "TAXABLE", "NET"]);
/** Roots of context objects (member accesses like `employee.department`). */
const CTX_ROOTS = new Set(["employee", "contract", "worked_hours", "worked_days", "result"]);

/**
 * Extract the sibling-rule dependencies a rule declares.
 *
 * Sources of dependency edges (all coalesced):
 *   1. `parent_rule_id` — explicit parent linkage from the editor.
 *   2. `amount_base` when it references another rule code (i.e. not one
 *      of BASIC/GROSS/TAXABLE/NET).
 *   3. Identifiers pulled from `condition_expression` and
 *      `amount_expression` via `extractIdentifiers`, filtered to actual
 *      rule codes in the current rule set (built-in bases and context
 *      roots are dropped).
 *
 * Returned as rule *codes*; the graph builder resolves them to ids.
 */
function ruleDependencies(rule: SalaryRule, codeSet: Set<string>): string[] {
  const deps = new Set<string>();
  // Explicit editor linkage
  if (rule.parent_rule_id) {
    // parent id → resolved by the caller (we return codes only); include
    // as a synthetic edge via `__parent__:<id>` so cycle detection sees it.
    deps.add(`__parent__:${rule.parent_rule_id}`);
  }
  // Percentage rules that reference a sibling code as their base
  if (
    rule.amount_select === "percentage" &&
    rule.amount_base &&
    !BUILTIN_BASES.has(rule.amount_base) &&
    codeSet.has(rule.amount_base)
  ) {
    deps.add(rule.amount_base);
  }
  // Expression dependencies — parse both condition and amount
  const scan = (src: string | null | undefined) => {
    if (!src) return;
    let ids: string[] = [];
    try {
      ids = extractIdentifiers(src);
    } catch {
      // Bad expressions surface later via the evaluator; ignore here so
      // cycle detection still runs on the rules with valid syntax.
      return;
    }
    for (const id of ids) {
      if (BUILTIN_BASES.has(id) || CTX_ROOTS.has(id)) continue;
      if (codeSet.has(id)) deps.add(id);
    }
  };
  if (rule.condition_select === "expression") scan(rule.condition_expression);
  if (rule.amount_select === "expression") scan(rule.amount_expression);
  return [...deps];
}

/**
 * Return a topological order of rules honoring:
 *   - `sequence` as the natural tie-breaker (matches editor-visible order)
 *   - dependency edges from `ruleDependencies`
 *
 * Detects cycles via DFS coloring. On cycle, returns `{ cycle: [codes] }`
 * — the caller emits it as a `StructureEngineResult.errors` entry and
 * short-circuits the run (a cycle is a payroll-blocking authoring bug).
 */
export function topoSortRules(
  rules: SalaryRule[],
): { ordered: SalaryRule[] } | { cycle: string[] } {
  const active = rules.filter((r) => r.is_active);
  const byId = new Map(active.map((r) => [r.id, r]));
  const byCode = new Map(active.map((r) => [r.code, r]));
  const codeSet = new Set(byCode.keys());

  // Build adjacency: from dependency → this rule (Kahn semantics).
  const deps = new Map<string, Set<string>>();
  for (const r of active) deps.set(r.id, new Set());
  for (const r of active) {
    for (const d of ruleDependencies(r, codeSet)) {
      let depId: string | undefined;
      if (d.startsWith("__parent__:")) {
        depId = d.slice("__parent__:".length);
      } else {
        depId = byCode.get(d)?.id;
      }
      if (!depId || !byId.has(depId) || depId === r.id) continue;
      deps.get(r.id)!.add(depId);
    }
  }

  // DFS with three colors: white/grey/black. Grey re-entry = cycle.
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const ordered: SalaryRule[] = [];
  const roots = [...active].sort((a, b) => a.sequence - b.sequence);

  const visit = (id: string): string[] | null => {
    const c = color.get(id) ?? 0;
    if (c === 2) return null;
    if (c === 1) {
      // Cycle — reconstruct from the current DFS stack.
      const idx = stack.indexOf(id);
      const cyc = stack.slice(idx).concat(id).map((x) => byId.get(x)!.code);
      return cyc;
    }
    color.set(id, 1);
    stack.push(id);
    const outgoing = [...deps.get(id)!].sort((a, b) => {
      const sa = byId.get(a)?.sequence ?? 0;
      const sb = byId.get(b)?.sequence ?? 0;
      return sa - sb;
    });
    for (const d of outgoing) {
      const cyc = visit(d);
      if (cyc) return cyc;
    }
    stack.pop();
    color.set(id, 2);
    ordered.push(byId.get(id)!);
    return null;
  };

  for (const r of roots) {
    const cyc = visit(r.id);
    if (cyc) return { cycle: cyc };
  }
  return { ordered };
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
  const { rules, workEntryTypes, workEntries, employee, contract, statutoryResolver, traceSink } = input;

  const { worked_hours, worked_days } = aggregateWorkedHours(workEntries, workEntryTypes);

  const results: Record<string, number> = {};
  const lines: PayslipLine[] = [];
  const errors: StructureEngineResult["errors"] = [];
  let basic = 0, gross = 0, taxable = 0, deductions = 0, employer = 0;

  // Phase 3 — Topological sort with cycle detection. Falls back to
  // sequence-only ordering (previous behaviour) when the sort surfaces a
  // dependency cycle: we short-circuit and return the cycle as a
  // payroll-blocking error so the run is not silently zeroed.
  const codeSet = new Set(rules.filter((r) => r.is_active).map((r) => r.code));
  const topo = topoSortRules(rules);
  if ("cycle" in topo) {
    errors.push({
      rule_code: topo.cycle.join(" → "),
      message: `dependency cycle detected among salary rules: ${topo.cycle.join(" → ")}. Fix by breaking one of the references (parent_rule_id, amount_base, or an expression).`,
    });
    return {
      lines: [],
      totals: { gross: 0, deductions: 0, employer: 0, net: 0, basic: 0, taxable: 0 },
      errors,
    };
  }
  const sorted = topo.ordered;

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

    // Precompute the dependency set for the trace sink so historical
    // simulators can rebuild the DAG without re-parsing expressions.
    const deps = ruleDependencies(rule, codeSet).filter((d) => !d.startsWith("__parent__:"));

    // Condition
    let conditionPassed = true;
    try {
      if (rule.condition_select === "expression" && rule.condition_expression) {
        const passed = evaluateExpression(rule.condition_expression, ctx);
        conditionPassed = Boolean(passed);
        if (!conditionPassed) {
          results[rule.code] = 0;
          traceSink?.push({
            rule_id: rule.id,
            rule_code: rule.code,
            sequence: rule.sequence,
            category: rule.category,
            condition_expression: rule.condition_expression,
            condition_passed: false,
            amount_select: rule.amount_select,
            amount_expression: rule.amount_expression,
            amount_base: rule.amount_base,
            base_value: 0,
            dependencies: deps,
            resolved_amount: 0,
            error: null,
          });
          continue;
        }
      }
    } catch (e) {
      const re = e instanceof RuleExpressionError ? e : null;
      const msg = `condition: ${(e as Error).message}`;
      errors.push({ rule_code: rule.code, message: msg, offset: re?.offset });
      traceSink?.push({
        rule_id: rule.id,
        rule_code: rule.code,
        sequence: rule.sequence,
        category: rule.category,
        condition_expression: rule.condition_expression,
        condition_passed: false,
        amount_select: rule.amount_select,
        amount_expression: rule.amount_expression,
        amount_base: rule.amount_base,
        base_value: 0,
        dependencies: deps,
        resolved_amount: 0,
        error: msg,
      });
      continue;
    }

    // Amount
    let amount = 0;
    let baseValue = 0;
    try {
      switch (rule.amount_select) {
        case "fixed":
          amount = rule.amount_fixed ?? 0;
          break;
        case "percentage": {
          baseValue = resolveBase(rule.amount_base, ctx, results);
          amount = baseValue * ((rule.amount_percentage ?? 0) / 100);
          break;
        }
        case "expression":
          amount = Number(evaluateExpression(rule.amount_expression ?? "0", ctx)) || 0;
          break;
        case "statutory_ref":
          if (!rule.statutory_rule_id || !statutoryResolver) {
            const msg = "statutory_ref rule missing resolver or rule_id";
            errors.push({ rule_code: rule.code, message: msg });
            traceSink?.push({
              rule_id: rule.id,
              rule_code: rule.code,
              sequence: rule.sequence,
              category: rule.category,
              condition_expression: rule.condition_expression,
              condition_passed: true,
              amount_select: rule.amount_select,
              amount_expression: rule.amount_expression,
              amount_base: rule.amount_base,
              base_value: 0,
              dependencies: deps,
              resolved_amount: 0,
              error: msg,
            });
            continue;
          }
          amount = statutoryResolver(rule.statutory_rule_id, ctx);
          break;
      }
    } catch (e) {
      const re = e instanceof RuleExpressionError ? e : null;
      const msg = `amount: ${(e as Error).message}`;
      errors.push({ rule_code: rule.code, message: msg, offset: re?.offset });
      traceSink?.push({
        rule_id: rule.id,
        rule_code: rule.code,
        sequence: rule.sequence,
        category: rule.category,
        condition_expression: rule.condition_expression,
        condition_passed: true,
        amount_select: rule.amount_select,
        amount_expression: rule.amount_expression,
        amount_base: rule.amount_base,
        base_value: baseValue,
        dependencies: deps,
        resolved_amount: 0,
        error: msg,
      });
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

    traceSink?.push({
      rule_id: rule.id,
      rule_code: rule.code,
      sequence: rule.sequence,
      category: rule.category,
      condition_expression: rule.condition_expression,
      condition_passed: true,
      amount_select: rule.amount_select,
      amount_expression: rule.amount_expression,
      amount_base: rule.amount_base,
      base_value: baseValue,
      dependencies: deps,
      resolved_amount: amount,
      error: null,
    });
  }

  return {
    lines,
    totals: { gross, deductions, employer, net: gross - deductions, basic, taxable },
    errors,
  };
}

