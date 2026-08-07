# Document & Financial Report Typography Audit

Date: 2026-08-08
Scope: every PDF emitted by `supabase/functions/_shared/pdf/**` plus the
on-screen report engine in `src/design-system/reports/**`.

## Verdict

The screen side was already legible; the PDF side was not. A single theme
(`themes/accountantMono.ts`) governed both a one-page invoice and a
40-column landscape general ledger, so the constants tuned for a compact
transactional document were also applied to analytical statements.

Measured on the pre-change renderer:

| Surface | Body type | Numeric shrink floor | Gutter |
| --- | --- | --- | --- |
| Invoice / delivery note | 7.5pt | 6pt | 72pt |
| Balance sheet, P&L, trial balance | 7.5pt | 6pt | 72pt |
| General ledger (landscape, 7+ cols) | 7.5pt → 6pt | 6pt | 72pt |

Two failures compounded:

1. **Uniform 7.5pt body type.** Acceptable at arm's length on an A4
   portrait invoice; below the practical reading floor for a statement a
   controller reads for an hour.
2. **Shrink-first density handling.** When columns did not fit, the table
   shrank numerals to 6pt while leaving a 1-inch gutter untouched on both
   sides. Landscape reports then get downscaled again by the viewer to
   fit the window, so 6pt renders nearer 4.5pt effective.

The on-screen engine (`ReportTable`) renders at 14px with 11px uppercase
headers and needed no change. The defect was print-only.

## Change: presentation profiles

`supabase/functions/_shared/pdf/themes/presentation.ts` introduces four
profiles. A profile is a token set — type sizes, row height, margins and
the numeric shrink floor — resolved once and threaded through
`BrandedHeader`, `DataTable` and `BrandedFooter`.

| Profile | Body | Header | Floor | Gutter | Used by |
| --- | --- | --- | --- | --- | --- |
| `document` | 7.5pt | 8pt | 6pt | 72pt | all transactional documents (unchanged) |
| `statement` | 10pt | 10pt | 9pt | 72pt | balance sheet, P&L, trial balance, cash flow |
| `ledger` | 8.5pt | 9pt | 7.5pt | 40pt | 7+ column registers, general ledger, aging |
| `operational` | 9pt | 9.5pt | 8pt | 54pt | narrow registers and listings |

Density is now handled by reclaiming gutter before touching type size, and
the shrink floor per profile is set above the legibility threshold rather
than at a fixed 6pt.

### Measured result

Rendered fixtures (`pdfplumber` glyph measurement, letter paper):

| Fixture | Before | After | Pages |
| --- | --- | --- | --- |
| 7-col landscape ledger, 60 rows | 7.5pt body, 72pt gutter | 8.5pt body, 40pt gutter | 2 → 2 |
| 4-col portrait statement | 7.5pt body | 10pt body | 1 → 1 |

Larger type cost no extra pages: the reclaimed 64pt of horizontal gutter
absorbed the increase.

## Blast-radius control

`generateReportPdf` treats the profile as **opt-in** and defaults to
`document`. Regulator- and layout-pinned callers — `generate-tax-certificate`,
`generate-statutory-return`, `generate-payroll-document` — pass nothing and
render exactly as before. Only the analytical funnel
(`_shared/reports/renderReport.ts`) resolves a profile, from the report
registry (`ReportSpec.presentationProfile`) or, absent that, by inference
from format profile and column count.

Transactional documents built by `_shared/pdfGenerator.ts` (invoices,
statements, remittance advice) call `drawDataTable` with no typography
argument and are therefore untouched.

## Guards

`supabase/functions/_shared/pdf/__tests__/report-typography_test.ts`:

- `document` profile is asserted equal to the legacy `theme` tokens — if
  it drifts, every invoice reformats, so the test fails first.
- Omitted or unknown profile resolves to `document`.
- Report profiles may never drop body type below 8.5pt or the shrink
  floor below 7.5pt.
- Dense profiles must reclaim gutter; statements must keep the statutory
  1-inch gutter.
- Rendered regression: omitting the profile is byte-equivalent (modulo
  the timestamp) to passing `document`, and the `ledger` profile adds at
  most one page versus the old rendering.

## Follow-ups

- Per-report overrides: `ReportSpec.presentationProfile` is wired but only
  inference is in use; pin individual reports as feedback arrives.
- Statement-profile reports are still letter/A4 portrait by default;
  revisit paper defaults for the widest statutory statements.
