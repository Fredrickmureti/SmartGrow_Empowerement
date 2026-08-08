# Financial Statement Document Architecture — Audit & Convergence

## A. Current architecture (verified)

```text
report page (React)  ──builds columns + rows──►  ExportConfig
        │                                            │
        │                                    buildRenderPayload
        ▼                                            ▼
  ReportTable / ReportSurface (screen)      render-report (edge fn)
                                                     │
                                          _shared/reports/renderReport.ts
                                       (registry spec, scope, branding, profile)
                                                     │
                                        _shared/reportPdfGenerator.ts
                                                     │
                          PdfBuilder + BrandedHeader + DataTable + BrandedFooter
                                                     ▼
                                                    PDF
```

Single server renderer, single PDF library, single table component. That
pipeline is sound and is kept.

## B/C. Root causes (evidence, not cosmetics)

1. **Statement structure is authored in page components, not in a contract.**
   `CashFlowReport.tsx:69-122` and `FinancialReports.tsx:295-416` each
   hand-assemble section/subtotal/total rows with their own labels and
   depths. Nothing validates the resulting shape, so three statements have
   three different grammars.
2. **Caller columns override the registry** (`resolveColumns.ts`: explicit
   wins). Cash Flow posts `item | amount` while the registry declares
   `section | item | amount` (`columnSpecs.ts:116-126`). The interactive PDF
   and the scheduled/emailed PDF of the same statement therefore differ.
   Balance Sheet registry says `name | closing_balance`; the page posts
   different keys. The registry is effectively dead for the UI path.
3. **The semantic vocabulary is too small to express a statement.** The row
   contract is only `_isHeader | _isSubtotal | _isGrandTotal | _depth`
   (`DataTable.ts:42-51`). Consequences visible in the attached PDFs:
   - P&L marks GROSS PROFIT, OPERATING PROFIT and NET INCOME all as
     `grandTotal` → three identical double-rule bands, no single result line.
   - Cash Flow marks both "Net Increase/(Decrease)" and "Closing Cash" as
     `grandTotal`, and "Opening Cash" as a plain detail row between them.
   - Balance Sheet marks TOTAL ASSETS and TOTAL LIABILITIES & EQUITY the
     same as section subtotals, so the balancing pair reads as noise.
4. **Vertical rhythm is destroyed on export.** `toExportRows` drops
   `kind: "spacer"` (`model.ts:120`), so sections butt against each other in
   the PDF while the screen breathes.
5. **No statement-grade number policy.** Zero prints `0.00` rather than the
   accounting em-dash; only null/empty becomes `—` (`DataTable.ts:154`).
   Negatives are already parenthesised (`format/currency.ts:45`) — correct,
   keep.
6. **No NOTE column, no comparative column, no "Page X of Y", no
   "(continued)" marker.** Footer stamps `Page N` only
   (`BrandedFooter.ts:51`).
7. **Header is already converged** — `drawBrandedHeader` routes every wide
   report to the operational masthead and `ReportSurface` mirrors it. No
   second header implementation will be created; the centered
   `drawFinancialMasthead` is dead code and gets deleted.
8. **Drill-down metadata exists but is never populated.** `RowMeta`
   (`DataTable.ts:35-40`) is defined and ignored; pages instead attach
   non-serialisable `onClick` closures, so traceability cannot survive to
   the server or an audit pack.

Numbers themselves are correct — no accounting change is in scope.

## D. Document families

| Family | Members | Grammar |
| --- | --- | --- |
| Financial statements | P&L, Balance Sheet, Cash Flow | statement contract (below) |
| Ledger reports | Trial Balance, GL, Partner Ledger, Journal, Aging | wide ledger grid, current behaviour retained |
| Operational | Sales, Purchases, Inventory, POS, Projects, CRM | register grid, unchanged |
| Payroll / HR | Register, Cost, Statutory | unchanged |
| Transactional documents | Invoice, Quote, PO, Receipt, Credit Note | `document` profile, byte-stable, untouched |

Only the first family changes in this wave.

## E. Canonical financial-statement contract

New shared module `supabase/functions/_shared/reports/statement.ts`
(imported by the client through a thin re-export) defining:

```text
StatementSpec {
  statement: "profit_and_loss" | "balance_sheet" | "cash_flow"
  basis, currency, period | asOf, comparative?
  columns: description | note? | current | comparative?
  lines: StatementLine[]
}

StatementLine.kind =
  detail | section | subsection | subtotal | major_total |
  grand_total | calculated_result | note | spacer
```

Renderer rules owned centrally (page components never style):

| kind | Typography | Rules | Spacing |
| --- | --- | --- | --- |
| section | bold uppercase, depth 0 | none | space above |
| subsection | bold, depth 1 | none | — |
| detail | regular, depth 2+ | none | — |
| subtotal | bold | thin rule above | — |
| major_total | bold, +0.5pt | single rule above | space above |
| calculated_result | bold uppercase | rule above + below | space above/below |
| grand_total | bold uppercase | double rule above | space above |
| note | italic small | — | — |
| spacer | — | — | preserved into PDF |

Statement builders derive lines from the existing accounting data, so
values stay identical: P&L → GROSS PROFIT / OPERATING PROFIT become
`calculated_result`, NET PROFIT becomes `grand_total`; Balance Sheet →
TOTAL CURRENT/NON-CURRENT are `subtotal`, TOTAL ASSETS and TOTAL
LIABILITIES & EQUITY are `grand_total`, TOTAL LIABILITIES / TOTAL EQUITY
are `major_total`; Cash Flow → three `major_total` activity nets, NET
INCREASE as `calculated_result`, Opening as `detail`, CLOSING CASH as
`grand_total`.

## F/G. Renderer changes

- Extend `TableRow` with `_kind` (superset of today's three booleans, which
  keep working) and `_note`; extend `DataTable` with the rule/spacing table
  above and honour `spacer`.
- Statement profile number policy: zero → `—`, negatives in parentheses
  (already), no currency symbol repetition per row (symbol stated in the
  masthead column head).
- Footer: `Page X of Y` (two-pass page count) and a continuation
  `<Statement> (continued)` line under the masthead on pages ≥ 2.
- Optional NOTE column rendered only when at least one line carries a note.
- Comparative column supported by the contract and rendered when present;
  no data work in this wave.

## H. Traceability

Statement lines carry `_meta { accountIds, journalId, sourceDocType,
sourceDocId }` — serialisable, sent to the server, ignored by the PDF, and
consumed by the screen for drill-down. `onClick` closures are replaced by
`_meta`-driven drill-down in `ReportTable`, so screen and audit-pack use
one source of truth.

## I. Enterprise research

Before implementation, confirm conventions against SAP / Oracle / NetSuite
/ Dynamics / Odoo statement output for: single result line per statement,
note-number column, comparative column placement, double rule reserved for
the final figure, zero as dash, `Page X of Y` and continuation headers,
basis and currency in the masthead rather than in rows. Findings recorded
in `docs/audit/2026-08-08-financial-statement-architecture.md`; anything
where the current architecture is already stronger is kept.

## J. Phased implementation (risk-ordered)

1. **Audit doc + baseline PDFs.** Generate P&L, BS, CF, TB and one invoice
   before any change; record every figure for diffing.
2. **Contract module** `statement.ts` + registry entries reconciled so the
   registry columns match what the statements actually post (kills the
   interactive-vs-scheduled drift). Remove duplicate
   `income_statement`/`profit_and_loss` divergence.
3. **Renderer**: `_kind` semantics, spacing, rules, spacer, zero-as-dash,
   `Page X of Y`, continuation header — all gated to the statement
   presentation profile so `document`/ledger/operational output is
   byte-stable.
4. **Statement builders**: P&L, Balance Sheet, Cash Flow emit contract
   lines; screen and export consume the same lines. No calculation edits.
5. **Notes column + comparative plumbing** (rendering only).
6. **Traceability**: `_meta` on lines, `ReportTable` drill-down off `_meta`.
7. **Delete dead `drawFinancialMasthead`.**
8. **Redeploy** `render-report` and `process-scheduled-reports`; bump the
   `pdfCache` version.

## K. Regression strategy

- Existing guard `presentation.ts` test asserting `document` ≡ legacy
  `accountantMono` stays green → invoices, delivery notes, statements,
  remittance advice unchanged.
- New Deno tests: registry columns match each statement builder's posted
  keys; every `_kind` maps to exactly one rule/spacing treatment; a
  statement can only carry one `grand_total`-class final figure.
- Value regression: script asserts every numeric cell of the before/after
  PDFs for P&L, BS, CF, TB is identical.
- Ledger/operational/payroll reports rendered before and after and diffed
  for no change.
- Nothing under printing / hardware / PrintService / ESC-POS / ZPL is
  touched; the PDF bytes remain the print payload.

## Technical notes

Files expected to change: `_shared/reports/statement.ts` (new),
`_shared/reports/columnSpecs.ts`, `_shared/pdf/components/DataTable.ts`,
`_shared/pdf/components/BrandedFooter.ts`,
`_shared/pdf/themes/presentation.ts`, `_shared/reports/renderReport.ts`,
`src/design-system/reports/model.ts`, `ReportTable.tsx`,
`src/pages/reports/FinancialReports.tsx`,
`src/pages/reports/CashFlowReport.tsx`,
`src/services/reports/pdfCache.ts`, plus tests and the audit doc.
