# Report masthead: screen vs downloaded PDF

## What you saw, measured

Downloaded `Profit_Loss_Statement_2026-08-16.pdf`, text extracted:

```text
Profit & Loss Statement
Joshua Holdings
KE
Jan 1, 2026 - Aug 31, 2026
Report generated: 2026-08-15 22:35:54 UTC
```

Screen masthead (your screenshot):

```text
Profit & Loss Statement
For the period Jan 1, 2026 - Aug 31, 2026
Accrual Basis
Headquarters (HQ)
Prepared on 16 Aug 2026
```

So the PDF is missing three things the screen states: the "For the period"
wording, the **basis** line ("Accrual Basis") and the **scope** line
("Headquarters (HQ)"). The logo is missing in both.

Verdict: **this is a real defect, not a standard.** IFRS/IAS 1 and every
comparable system (Odoo, NetSuite, QuickBooks, Xero, SAP) require a statement
to be self-identifying: entity, statement name, period covered, basis, and
the reporting entity/scope. A bare "Jan 1, 2026 - Aug 31, 2026" is ambiguous
(period covered? print range?) and the basis is legally material.

## Root causes (confirmed by reading the code)

1. **The PDF header drops fields it is handed.**
   `supabase/functions/_shared/reports/renderReport.ts` *does* resolve the
   scope line (`resolveReportScope`) and passes `scope`, `subtitle`, `asOf`
   to `drawBrandedHeader`. But per the 2026-08 "one masthead" decision,
   `drawBrandedHeader` always calls `drawOperationalHeader`, and that function
   destructures only `{ title, dateRange, organization, companyName, logo }`.
   `scope`, `subtitle` and `asOf` are silently discarded, and `dateRange` is
   printed raw with no "For the period" / "As of" prefix. The centered
   `drawFinancialMasthead` that *did* render them is dead reference code.
   Consequence: **Balance Sheet loses its "As of" date semantics entirely**
   — same bug class, arguably worse.

2. **The page never sends the basis.**
   `src/pages/reports/FinancialReports.tsx` sets `subtitle="Accrual Basis"`
   on the on-screen `ReportSurface` (lines 620, 657) but `getPnlExportConfig`
   / `getBsExportConfig` omit `subtitle`. So even after fix 1, the basis line
   would still be blank on paper. Identity (business, branch) *is* injected
   correctly by `ReportPageLayout` via `enrichExportConfig`, so scope only
   needs fix 1.

3. **The logo 404s.** `businesses.logo_url` points at
   `organization-assets/.../logo.jpeg?t=...`; fetching it returns **HTTP 400**
   (object not found). That is why the screen shows a broken-image icon and
   the PDF prints no logo — the stored object is gone, not a rendering bug.

## Your branch question — how scope works

Scope is **single-context, not a list**, and that is the correct enterprise
behaviour. `resolveReportScope` (server) and `useFinanceScope` (screen) both
derive exactly one line from the branch you have selected:

| Selected context | Masthead scope line |
| --- | --- |
| A branch, flagged HQ | `Headquarters (HQ)` |
| A branch, not HQ | `Nairobi Branch` |
| No branch (consolidated) | `All branches` |
| Business name differs from masthead name | `Acme Ltd · Nairobi Branch` |

With a second branch added you would still see one line: either that branch's
name, or `All branches` when you clear the branch filter — never both branches
listed. Odoo, NetSuite and SAP behave identically: a statement is issued for
one reporting scope; comparing branches is a separate multi-column /
segment-report feature, not a masthead change.

Two related notes, both already correct in code:
- P&L is branch-sliceable (`branchId: filters.branchId`), while the Balance
  Sheet deliberately forces `branchId: null` — assets/liabilities/equity
  belong to the legal entity, not a branch. That matches accounting practice.
- The screen and server use byte-identical scope wording, so once the PDF
  prints the line at all, they cannot disagree.

## Proposed fix (nothing changed yet)

1. `BrandedHeader.ts` — `drawOperationalHeader` renders, right-aligned under
   the title, in order: period line (`For the period …` / `As of …`), basis
   subtitle, scope line, then `Prepared on …`. Line-height and separator
   position grow with the number of lines so nothing collides. This fixes
   every report at once, PDF and emailed/scheduled copies included.
2. `FinancialReports.tsx` — add `subtitle: "Accrual Basis"` to both export
   configs so the basis travels with the export.
3. Guard test in `supabase/functions/_shared/pdf/` asserting a rendered
   report's text contains the period prefix, basis and scope when supplied.
4. Bump `v` in `src/services/reports/pdfCache.ts` and redeploy `render-report`
   plus `process-scheduled-reports` (required after `_shared/pdf` changes).
5. Separately: re-upload the business logo (data issue, not code). Optional
   hardening — surface a settings warning when `logo_url` fails to load.

## Technical notes

- Files: `supabase/functions/_shared/pdf/components/BrandedHeader.ts`,
  `supabase/functions/_shared/reports/renderReport.ts` (read-only, already
  correct), `src/pages/reports/FinancialReports.tsx`,
  `src/services/reports/pdfCache.ts`.
- No schema, RLS or data-query changes. Row values are unaffected — this is
  masthead-only.
- `mem/features/report-masthead-single-layout.md` stays valid: one layout for
  all reports; this change makes that one layout carry the full statutory
  header content instead of a subset.
