/**
 * statementKinds.ts — the canonical semantic vocabulary for a financial
 * statement line, and the ONE table that maps each kind to its typographic
 * treatment.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module, a statement could only say `_isHeader` /
 * `_isSubtotal` / `_isGrandTotal`. Three flags cannot express a real
 * statement, so every page invented its own grammar:
 *
 *   - P&L marked GROSS PROFIT, OPERATING PROFIT and NET INCOME all as
 *     "grand total" → three identical double-rule bands and no single
 *     result line.
 *   - Cash Flow marked both "Net Increase in Cash" and "Closing Cash" as
 *     grand totals, with "Opening Cash" as an unmarked detail row between
 *     them.
 *   - Balance Sheet gave TOTAL ASSETS the same weight as a section
 *     subtotal, so the balancing pair read as noise.
 *
 * A statement now declares WHAT a line IS. This table decides how it looks,
 * for the screen and for the PDF, once. Page components never style.
 *
 * This file is deliberately dependency-free and is mirrored verbatim at
 * `supabase/functions/_shared/reports/statementKinds.ts` so the server
 * renderer and the on-screen table cannot drift. A vitest guard
 * (`src/test/architecture/statement-kinds-parity.test.ts`) asserts the two
 * copies are identical.
 */

export const STATEMENT_LINE_KINDS = [
  /** An account / caption line carrying figures. */
  "detail",
  /** Top-level caption: ASSETS, REVENUE, CASH FLOWS FROM OPERATING… */
  "section",
  /** Nested caption inside a section: "Adjustments for non-cash items". */
  "subsection",
  /** Sums the detail lines immediately above it. */
  "subtotal",
  /** Sums subtotals: TOTAL LIABILITIES, Net cash from operating. */
  "major_total",
  /** A derived figure, not a sum: GROSS PROFIT, NET INCREASE IN CASH. */
  "calculated_result",
  /** The single final figure of the statement. Double rule. */
  "grand_total",
  /** Narrative / note line. No figures. */
  "note",
  /** Vertical breathing space. Preserved into the PDF. */
  "spacer",
] as const;

export type StatementLineKind = (typeof STATEMENT_LINE_KINDS)[number];

export type Rule = "none" | "thin" | "single" | "double";

export interface LineTreatment {
  bold: boolean;
  /** Use the emphasis (slightly larger) body size. */
  emphasis: boolean;
  /** Upper-case the label. Applied only under the statement profile. */
  uppercase: boolean;
  ruleAbove: Rule;
  ruleBelow: Rule;
  /** Extra points of space above/below. Statement profile only. */
  spaceAbove: number;
  spaceBelow: number;
  /** Renders as a full-width caption band rather than a value row. */
  caption: boolean;
}

const base: LineTreatment = {
  bold: false,
  emphasis: false,
  uppercase: false,
  ruleAbove: "none",
  ruleBelow: "none",
  spaceAbove: 0,
  spaceBelow: 0,
  caption: false,
};

/**
 * The single treatment table. Rules here reproduce the pre-existing
 * behaviour for `detail` / `section` / `subtotal` / `grand_total` exactly,
 * so every non-statement report (ledgers, registers, invoices) renders
 * byte-identically; the new kinds only appear where a statement emits them.
 */
export const STATEMENT_LINE_TREATMENT: Record<StatementLineKind, LineTreatment> = {
  detail: { ...base },
  section: { ...base, bold: true, emphasis: true, uppercase: true, spaceAbove: 6, caption: true },
  subsection: { ...base, bold: true, spaceAbove: 2 },
  subtotal: { ...base, bold: true, ruleAbove: "thin" },
  major_total: { ...base, bold: true, emphasis: true, ruleAbove: "single", spaceAbove: 4 },
  calculated_result: {
    ...base,
    bold: true,
    emphasis: true,
    uppercase: true,
    ruleAbove: "single",
    ruleBelow: "single",
    spaceAbove: 5,
    spaceBelow: 3,
  },
  grand_total: {
    ...base,
    bold: true,
    emphasis: true,
    uppercase: true,
    ruleAbove: "double",
    spaceAbove: 5,
  },
  note: { ...base },
  spacer: { ...base },
};

/** Kinds that behave as a total (label spans the description columns). */
export const TOTAL_LINE_KINDS: StatementLineKind[] = [
  "subtotal",
  "major_total",
  "calculated_result",
  "grand_total",
];

export function isTotalLineKind(kind: StatementLineKind): boolean {
  return TOTAL_LINE_KINDS.includes(kind);
}

/**
 * Resolve the kind of an exported row. `_kind` wins; otherwise the legacy
 * boolean flags are mapped, so pre-contract reports keep working.
 */
export function resolveLineKind(row: {
  _kind?: string;
  _isHeader?: boolean;
  _isSubtotal?: boolean;
  _isGrandTotal?: boolean;
}): StatementLineKind {
  const explicit = row._kind as StatementLineKind | undefined;
  if (explicit && (STATEMENT_LINE_KINDS as readonly string[]).includes(explicit)) {
    return explicit;
  }
  if (row._isGrandTotal) return "grand_total";
  if (row._isSubtotal) return "subtotal";
  if (row._isHeader) return "section";
  return "detail";
}
