# Report Typography & Density Audit — findings so far, then a phased fix

## What I verified in the code (not assumed)

- **There is exactly one PDF typography source**: `supabase/functions/_shared/pdf/themes/accountantMono.ts`. Its docstring says outright it is "the canonical theme for ALL reports and documents". Invoices/estimates/POs read it through `LineItemsTable`/`TotalsBlock`; analytical reports read the same object through `DataTable`. **Any global size change hits invoices too** — so a global bump is off the table.
- **Measured token values today**: body cell `7.5pt`, table header `8pt`, emphasis (subtotal/total/section) `8.5pt`, metadata/timestamp `8pt`, title `18pt`, row height `14pt`, page margin `72pt`, bottom `60pt`.
- **Reports shrink further at render time**: `DataTable` reduces numeric cell font in 0.25pt steps down to a floor of `6pt` when a column is too narrow (`MIN_NUMERIC_FONT_SIZE = 6`). Invoices do not do this. So dense ledgers can legitimately end up at 6–7pt.
- **Reports default to landscape**: `renderReport` and `PdfBuilder` both default `orientation: "landscape"`, and the registry (`columnSpecs.ts`, ~30 specs) marks most report families landscape. A landscape A4 page is 842pt wide; every desktop viewer fits that to the window, so the user's "100%" is usually an additional 0.75–0.9x reduction on top of already-small type. This is a real compounding factor, not just a viewer misconception.
- **An extension point already exists and is under-used**: `formatProfile: "financial" | "operational"` already flows registry → `renderReport` → `reportPdfGenerator`, but today it only decides whether to draw a logo. `PdfBuilder` also already carries a `density` concept (`wide` | `narrow`) and a margin override. Typography belongs on these existing seams — no new renderer is needed.
- **Screen side is separately defined**: `ReportTable` uses `text-sm` body with `text-[11px]` uppercase headers and `py-1.5` rows — visually denser hierarchy than the PDF but not the same scale. Consistency work is about hierarchy, not pixel parity.

**Working root-cause hypothesis (to be confirmed by measurement in Phase 0):** the small/dense appearance is *not* a single bug. It is (a) genuinely undersized body type for analytical output (7.5pt, floor 6pt) against an enterprise norm of ~8.5–10pt, (b) landscape-by-default forcing viewer downscale, and (c) column count/width pressure triggering the auto-shrink path. Transactional documents escape most of this because they have few columns and portrait pages — which matches the user's observation that invoices look fine.

## Phase 0 — Measure before changing anything

Generate real PDFs for a representative set (Trial Balance, General Ledger, P&L, Balance Sheet, Aging, Payroll Register, Stock Valuation, plus invoice / estimate / PO / credit note as controls) and extract, per document, actual glyph point sizes, page box, margins, row pitch, column widths, and how often the auto-shrink floor is hit. Record the numbers in `docs/audit/report-typography.md`. No code changes in this phase.

## Phase 1 — Split typography into presentation profiles

Introduce a resolved token set (not a second theme file, not a second renderer): `resolveTypography(profile)` in `_shared/pdf/themes/`, returning the existing `theme` shape with per-profile size/spacing overrides.

- `document` — invoices, estimates, quotes, POs, sales orders, credit notes, receipts. **Returns today's values unchanged, byte-for-byte.**
- `statement` — Balance Sheet, P&L, Cash Flow, statutory statements. Few columns, so it can afford ~10pt body, taller rows, portrait.
- `ledger` — Trial Balance, General Ledger, Partner/Vendor/Customer ledger, Journal, Aging, Payroll Register. Dense by nature: ~8.5pt body, 9pt header, shrink floor raised from 6pt to 7.5pt, tighter margins (72pt → ~40pt) to buy width back instead of shrinking type.
- `operational` — inventory/sales/purchase/POS/project/CRM registers. ~9pt body.

Profile is chosen by the registry entry (`formatProfile` extended from two values to these four), never by the calling page. Components take the resolved tokens as a parameter instead of importing `theme` directly.

## Phase 2 — Attack density, not just size

For `ledger`/`operational` profiles: reduce page margins, allow the column allocator to spend the recovered width on the name/description column, and treat the auto-shrink path as a last resort with a higher floor. Where a report exceeds a column budget even then, prefer landscape + wrapped headers over shrinking digits. Reports whose spec is portrait but whose column count is too high get flipped in the registry, one entry at a time, with a before/after page-count check.

## Phase 3 — Hierarchy

Strengthen title / period / entity / column-group / section / subtotal / grand-total / page-footer separation using weight, rules and spacing (the theme is deliberately tint-free — keep it that way). Mirror the same hierarchy rules in `ReportSurface`/`ReportTable` so screen and PDF read as one document. No colour introduced.

## Phase 4 — Regression protection

Fixture tests under `supabase/functions/_shared/pdf/__tests__/` that render invoice, estimate, quotation, purchase order and credit note and assert page count, drawn text extents, column alignment and absence of clipping are **identical to the pre-change baseline**. Plus report fixtures asserting the new minimum effective point size is never breached. Printing, print policies, hardware routing, ESC/POS and ZPL are untouched throughout — the change lives strictly above `PrintService`.

## Deliverable

`docs/audit/report-typography.md` carrying sections A–I (current architecture, measurements, report classification, root cause, enterprise comparison, architecture assessment, proposed profile model, regression strategy, phased plan), written from the Phase 0 measurements and enterprise-practice research, then the phased implementation above.

## Technical notes

Files in scope: `_shared/pdf/themes/*`, `_shared/pdf/components/DataTable.ts` (+ siblings, to accept tokens), `_shared/pdf/PdfBuilder.ts` (margin/profile plumbing), `_shared/reports/columnSpecs.ts` (profile + orientation per report), `_shared/reports/renderReport.ts`, `_shared/reportPdfGenerator.ts`, and `src/design-system/reports/*` for screen hierarchy. Explicitly out of scope: `PrintService`, print policies, `print_jobs`, transports, drivers, ESC/POS, ZPL, `generate-document`'s routing, and all report data/accounting/payroll logic.
