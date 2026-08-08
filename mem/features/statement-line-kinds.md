---
name: Statement line-kind contract
description: Canonical semantic vocabulary (detail/section/subsection/subtotal/major_total/calculated_result/grand_total/note/spacer) that drives all financial statement typography on screen and in PDFs
type: feature
---

# Statement line kinds

`src/design-system/reports/statementKinds.ts` is mirrored **byte-identically**
to `supabase/functions/_shared/reports/statementKinds.ts`. Guard:
`src/test/architecture/statement-kinds-parity.test.ts`.

A statement row declares WHAT it is; `STATEMENT_LINE_TREATMENT` decides how
it looks. Page components must never style rows.

Semantics:

- `subtotal` sums the detail lines above it.
- `major_total` sums subtotals (Total liabilities, Net cash from operating).
- `calculated_result` is derived, not a sum (Gross profit, Operating profit,
  Profit before tax, Net increase in cash).
- `grand_total` is the statement's single final figure — double rule.
  Exception: the balance sheet's balancing pair (Total assets / Total
  liabilities and equity) are both grand totals by design.
- `spacer` survives into the PDF; `toExportRows` no longer drops it.

`toExportRows` emits `_kind` (the contract) plus legacy
`_isHeader`/`_isSubtotal`/`_isGrandTotal` so an older deployed renderer
degrades instead of breaking, and `_meta` for serialisable drill-down
provenance (never rendered).

After touching `_shared/pdf` or `_shared/reports`: redeploy `render-report`
AND `process-scheduled-reports`, and bump `v` in
`src/services/reports/pdfCache.ts` (now `v: 4`).
