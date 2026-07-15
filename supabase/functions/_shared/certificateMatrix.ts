// @ts-nocheck — Deno runtime
/**
 * certificateMatrix — assembles the semantic monthly matrix rows a v3
 * certificate template binds to (e.g. `p9.months`).
 *
 * A v3 `matrix` node describes:
 *   • `columns[]` — each may carry a `source_key` (a raw payroll rule code
 *     whose monthly amount feeds that column),
 *   • `rule_codes[]` — every raw code to pivot (superset of source keys;
 *     includes codes referenced only by derived expressions),
 *   • `derived_columns[]` — the pack's legal math (sum/sub/min/max/pct),
 *   • `amount_field` — which monthly amount to pivot on.
 *
 * The country's tax logic lives entirely in this pack-authored data; this
 * helper is generic and knows nothing about P9/KRA/Kenya.
 */
import {
  applyDerivedColumns,
  pivotToMonthlyMatrix,
  type DerivedColumn,
  type MonthlyRuleCodeRow,
} from "./monthlyMatrix.ts";

export interface MatrixColumnSpec {
  key?: string;
  id?: string;
  bind_key?: string;
  source_key?: string | null;
}

function columnTargetKey(c: MatrixColumnSpec): string {
  return String(c.key ?? c.bind_key ?? c.id ?? "");
}

export function collectMatrixRuleCodes(matrixNode: any): string[] {
  const columns: MatrixColumnSpec[] = Array.isArray(matrixNode?.columns) ? matrixNode.columns : [];
  const fromColumns = columns
    .map((c) => (c?.source_key ? String(c.source_key) : ""))
    .filter(Boolean);
  const explicit = Array.isArray(matrixNode?.rule_codes)
    ? matrixNode.rule_codes.map((c: any) => String(c)).filter(Boolean)
    : [];
  return Array.from(new Set([...explicit, ...fromColumns]));
}

/**
 * Validate that every string arg in every derived-column expression resolves
 * to a real symbol available on the matrix row at derivation time. Namely:
 *   1) another column's `key` / `bind_key` / `id`,
 *   2) an earlier `derived_columns[j].key` (j < i), or
 *   3) a raw rule_code listed in `matrix.rule_codes` (or exposed via any
 *      column's `source_key`, which is included in that superset).
 *
 * Numeric literal args are always allowed. Unknown symbols would silently
 * evaluate to 0 (see monthlyMatrix.argValue) — this check turns that class
 * of latent template bug into a loud structural failure.
 *
 * Returns the list of offences (empty when the matrix is valid). Callers
 * decide whether to throw (runtime generator) or aggregate (tests).
 */
export interface MatrixDerivedArgOffence {
  derived_key: string;
  arg: string;
  index: number;
}

export function collectDerivedArgOffences(matrixNode: any): MatrixDerivedArgOffence[] {
  const columns: MatrixColumnSpec[] = Array.isArray(matrixNode?.columns) ? matrixNode.columns : [];
  const derived: any[] = Array.isArray(matrixNode?.derived_columns)
    ? matrixNode.derived_columns
    : [];
  if (derived.length === 0) return [];

  const columnKeys = new Set<string>();
  for (const c of columns) {
    const t = columnTargetKey(c);
    if (t) columnKeys.add(t);
  }
  const ruleCodes = new Set<string>(collectMatrixRuleCodes(matrixNode));
  const derivedKeysSoFar = new Set<string>();

  const offences: MatrixDerivedArgOffence[] = [];
  derived.forEach((d, idx) => {
    const args = Array.isArray(d?.args) ? d.args : [];
    for (const a of args) {
      if (typeof a === "number") continue;
      const s = String(a);
      // `cat:<category>` tokens are always resolvable — they are synthesised
      // per-row by `pivotToMonthlyMatrix` from `payslip_lines.category`.
      // This is the country-neutral aggregation channel used by generic
      // certificates (e.g. ANNUAL_EARNINGS_STATEMENT).
      if (s.startsWith("cat:")) continue;
      if (columnKeys.has(s) || derivedKeysSoFar.has(s) || ruleCodes.has(s)) continue;
      offences.push({ derived_key: String(d?.key ?? `#${idx}`), arg: s, index: idx });
    }
    if (d?.key) derivedKeysSoFar.add(String(d.key));
  });
  return offences;
}

/**
 * Does this matrix declare any category-aggregate reference (`cat:*`) in
 * its `derived_columns` args? When it does, the generator must call
 * `payroll_employee_monthly_breakdown` with `p_rule_codes = NULL` so every
 * payslip_line row (across all rule_codes) contributes to the category
 * rollups. Country-neutral templates rely on this.
 */
export function matrixUsesCategoryAggregation(matrixNode: any): boolean {
  const derived: any[] = Array.isArray(matrixNode?.derived_columns)
    ? matrixNode.derived_columns
    : [];
  for (const d of derived) {
    const args = Array.isArray(d?.args) ? d.args : [];
    for (const a of args) {
      if (typeof a === "string" && a.startsWith("cat:")) return true;
    }
  }
  return false;
}


/**
 * Pivot raw monthly rule-code rows into semantic matrix rows keyed by the
 * template's column keys, then apply the pack's derived columns.
 */
export function buildMatrixRows(
  monthlyRows: MonthlyRuleCodeRow[],
  matrixNode: any,
): Array<Record<string, number>> {
  const columns: MatrixColumnSpec[] = Array.isArray(matrixNode?.columns) ? matrixNode.columns : [];
  const derived: DerivedColumn[] | undefined = Array.isArray(matrixNode?.derived_columns)
    ? matrixNode.derived_columns
    : undefined;
  const amountField = (matrixNode?.amount_field as
    | "employee_amount"
    | "employer_amount"
    | "taxable_amount") ?? "employee_amount";

  const ruleCodes = collectMatrixRuleCodes(matrixNode);
  const pivot = pivotToMonthlyMatrix(monthlyRows, ruleCodes, amountField);

  // Alias each raw source code onto its semantic column key so that both
  // raw-code and column-key references resolve during derivation.
  for (const row of pivot) {
    for (const c of columns) {
      if (c?.source_key) {
        const target = columnTargetKey(c);
        if (target) row[target] = Number(row[String(c.source_key)] ?? 0);
      }
    }
  }

  return applyDerivedColumns(pivot, derived) as Array<Record<string, number>>;
}

/** Sum a numeric key across the built rows (used for footer/summary totals). */
export function sumMatrixColumn(
  rows: Array<Record<string, number>>,
  key: string,
): number {
  return rows.reduce((s, r) => s + (Number(r?.[key]) || 0), 0);
}
