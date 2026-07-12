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
  key: string;
  source_key?: string | null;
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
        row[c.key] = Number(row[String(c.source_key)] ?? 0);
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
