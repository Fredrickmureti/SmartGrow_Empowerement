# Financial Reporting: consolidate the on-screen reporting layer onto one engine

## What the audit found

I traced the reporting subsystem end to end before planning. The verdict is
narrower and more actionable than "everything is broken":

**Already a platform (do not rebuild):** the export/PDF side. Every PDF, CSV
and XLSX funnels through the `render-report` edge function into a single
`renderReport()` pipeline — shared branding, `financial` vs `operational`
masthead profiles, one number-format policy (parentheses for negatives, em
dash for empty), page headers/footers, run-hash audit trail in
`report_run_log`, column specs in a registry, and cron/email exports reusing
the same funnel. Client-side XLSX is banned by an ESLint rule. This is the
correct architecture and it stays.

**Not a platform:** everything the user actually reads on screen. There is a
shared page chrome (`ReportPageLayout`: title, scope badge, filters, export
buttons, loading/empty states) and a small `FinancialReportHeader`, and then
each report free-hands its own table. Concretely:

- 19 report pages hand-roll shadcn `<Table>` markup — 22 to 69 table
  elements each, ~12,000 lines total across `src/pages/reports/`.
- Row hierarchy is re-invented per page: Trial Balance writes
  `bg-muted/50 font-medium` for a section, `font-medium border-t` for a
  subtotal, `font-bold text-base bg-muted border-t-2` for the grand total.
  Other reports use different combinations for the same semantics.
- `tabular-nums`, `text-right`, `border-r`, `text-sm`/`text-xs` are applied
  cell-by-cell, so alignment and density drift between reports and some
  numeric columns miss tabular figures entirely.
- Currency formatting on screen comes from at least three sources
  (`useCurrency`, page-local `fmt`/`fmtOrDash` helpers, `lib/utils`), and
  none of them match the PDF policy — a negative renders as `-KES 1,234` on
  screen and `(KES 1,234.00)` in the PDF of the same report.
- No shared behaviour for long/wide reports: no sticky header, no sticky
  label column, no zebra/row-guide rhythm, no virtualization. Trial Balance
  is a 8-column wide table where the eye loses the row — that is the
  symptom that started this.
- Report content is not print-aware; printing goes through the PDF path, so
  what is on screen and what comes out of the printer are two separate
  layouts maintained independently.

So: the export engine is unified, the presentation engine is not. The fix is
to give the on-screen layer the same treatment printing already got, and to
make screen and PDF share one formatting and hierarchy contract.

## What gets built

### 1. A canonical financial table primitive

New `src/design-system/reports/` module, sitting beside the existing
`design-system/records` module and following the same descriptor style:

- `ReportTable` — column-spec driven (`key`, `header`, `align`, `format`,
  `width`, `sticky`, `priority`). Renders header, body, section groups,
  subtotals and grand totals from data, not from per-page JSX.
- Row semantics as first-class kinds — `detail`, `section`, `subtotal`,
  `grandTotal`, `spacer` — each with one styling definition. Depth-based
  indentation for hierarchical charts of accounts.
- Numeric columns get tabular figures, right alignment, consistent decimal
  rhythm and a single negative-number treatment by construction.
- Long/wide report behaviour built in: sticky header row(s), sticky leading
  label column, subtle row guides + section banding tuned for hour-long
  reading sessions and for grayscale printing, and column-group rules
  (Trial Balance's Opening / Movement / Closing pairs) rendered from the
  spec rather than hand-placed `border-r`.
- Column groups support `colSpan` header tiers so multi-tier headers stop
  being bespoke markup.

### 2. One formatting policy, shared with the PDF

A single `reportFormat` module exporting currency, number, percent and date
formatters that mirror the edge function's rules exactly (parentheses for
negatives, `—` for empty, two fraction digits, grouping). Report pages stop
defining local `fmt`/`fmtOrDash`. A test asserts the screen formatter and
the PDF formatter agree on a shared fixture set, so the two cannot drift.

### 3. A report surface + statutory masthead

`ReportSurface` wraps the table with the on-screen equivalent of the PDF
masthead: company, report title, period/as-of, basis subtitle, prepared-on,
and scope. It reuses `FinancialReportHeader`'s content and adopts the same
`financial` vs `operational` profile split the PDF registry already uses, so
the on-screen document and its PDF are recognisably the same document.

### 4. Migrate every report page onto it

All 19 table-bearing pages under `src/pages/reports/` are rewritten to
declare a column spec + typed rows and hand them to `ReportTable`; the
bespoke `<Table>` markup is deleted, not left behind. Where a page already
builds an `ExportConfig` for the PDF, the on-screen column spec and the
export columns are derived from one declaration so a column can never exist
in the PDF but not on screen.

Order: Trial Balance, General Ledger, Journal Report, Partner Ledger,
Financial Reports (P&L / Balance Sheet), Aging, Cash Flow → then Tax,
Budget, Depreciation, Bank Reconciliation, Consolidation, FX Revaluation,
Audit Trail, Control Account Reconciliation → then the stock/inventory and
sales report family.

### 5. Scale

`ReportTable` gains windowed rendering above a row threshold, so a
100k-line general ledger scrolls instead of freezing the tab, while keeping
section/subtotal rows anchored. Totals and subtotals are computed once from
the row model rather than recomputed inside render (Trial Balance currently
reduces per account type on every render pass).

### 6. Lock it in

An architecture test in `src/test/architecture/` forbids raw `<Table>`
imports and local currency formatters inside `src/pages/reports/`, matching
the existing `no-raw-xlsx-in-app` pattern this codebase already uses to stop
regressions. Plus an ADR recording that on-screen reporting is now a single
engine.

## Technical notes

- New module: `src/design-system/reports/` (`ReportTable`, `ReportSurface`,
  `columns.ts`, `rows.ts`, `format.ts`, `index.ts`).
- No database changes, no edge function changes to the render pipeline; the
  formatting parity test reads the existing shared PDF format rules.
- `ReportPageLayout` keeps its current responsibilities (scope, filters,
  export enrichment, view logging) and gains no new ones.
- Accessibility: semantic `<table>` with scope/headers attributes, section
  rows as row-group headers, contrast that survives grayscale printing.

## Out of scope

- Rebuilding the PDF/CSV/XLSX engine — it is already canonical.
- New reports, new financial logic, or changes to how balances are computed.
