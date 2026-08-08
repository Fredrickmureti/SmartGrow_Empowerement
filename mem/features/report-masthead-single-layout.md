---
name: One masthead for all reports
description: Every report PDF and on-screen surface uses the operational masthead layout (logo left, entity block left, title/period right); formatProfile only drives wording/typography
type: feature
---

# One report masthead

`drawBrandedHeader()` (`supabase/functions/_shared/pdf/components/BrandedHeader.ts`)
always renders `drawOperationalHeader` for wide paper. The centered
"financial" masthead (`drawFinancialMasthead`) is dead reference code — do
NOT re-route statutory reports to it.

- `formatProfile: "financial"` still controls wording ("As of ..." vs
  "For the period ...") and typography/density — never header layout.
- `src/design-system/reports/ReportSurface.tsx` mirrors this: `financial`
  is hard-set to `false` so screen == PDF.
- Narrow/thermal paper keeps `drawNarrowHeader`.
- After changing `_shared/pdf` or `_shared/reports`, redeploy
  `render-report` AND `process-scheduled-reports`, and bump `v` in
  `src/services/reports/pdfCache.ts`.
