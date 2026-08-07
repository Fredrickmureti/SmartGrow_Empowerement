/**
 * Column projection for report results — ONE owner, shared by every
 * representation of a report.
 *
 * Why this file exists:
 *   `render-report` used to resolve columns only inside `renderReport()`,
 *   i.e. only on the PDF path. The JSON/screen branch returned the raw
 *   builder result (`{ data, summary }`) verbatim, and no builder attaches
 *   a `columns` key. The screen therefore received rows with no column
 *   spec, rendered zero headers and zero cells, and showed nothing but the
 *   "Rows: N" metadata band — while the PDF of the SAME result was correct.
 *
 *   Column projection is a property of the REPORT RESULT, not of the PDF
 *   renderer. Both branches now call `resolveReportColumns`, so screen,
 *   PDF, CSV and XLSX provably share one projection.
 */

import type { ReportColumn, ReportRow } from "../reportPdfGenerator.ts";
import { getReportSpec } from "./columnSpecs.ts";

const INTERNAL_KEYS = new Set([
  "_isHeader",
  "_isSubtotal",
  "_isGrandTotal",
  "_depth",
  "_bold",
  "_meta",
]);

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Last-resort inference for legacy/unregistered reports. */
export function inferColumns(sample: ReportRow): ReportColumn[] {
  return Object.keys(sample)
    .filter((k) => !INTERNAL_KEYS.has(k))
    .map((key) => {
      const v = sample[key];
      const isNumber = typeof v === "number";
      return {
        key,
        header: humanize(key),
        align: isNumber ? "right" : "left",
        format: isNumber ? "currency" : "text",
      } as ReportColumn;
    });
}

/**
 * Resolve the column projection for a report result.
 *
 * Precedence: explicit caller columns > builder-supplied columns >
 * registry spec (`columnSpecs.ts`) > first-row inference.
 *
 * Returning `[]` is only possible for an empty result set with no
 * registry entry — a genuinely unknown report shape.
 */
export function resolveReportColumns(opts: {
  reportType?: string | null;
  /** Columns explicitly supplied by the caller (PREBUILT mode). */
  explicit?: ReportColumn[] | null;
  /** Columns a builder chose to attach to its own result. */
  fromResult?: ReportColumn[] | null;
  rows: ReportRow[];
}): ReportColumn[] {
  if (opts.explicit && opts.explicit.length > 0) return opts.explicit;
  if (opts.fromResult && opts.fromResult.length > 0) return opts.fromResult;

  const spec = opts.reportType ? getReportSpec(opts.reportType) : null;
  if (spec?.columns?.length) return spec.columns;

  if (opts.rows.length > 0) return inferColumns(opts.rows[0]);
  return [];
}
