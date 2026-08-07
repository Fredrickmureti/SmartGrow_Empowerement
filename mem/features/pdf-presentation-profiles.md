---
name: PDF presentation profiles
description: Typography profiles (document/statement/ledger/operational) that separate transactional-document PDF sizing from analytical report sizing
type: feature
---

# PDF presentation profiles

`supabase/functions/_shared/pdf/themes/presentation.ts` owns four token
sets resolved by `resolveTypography(profile)`:

| Profile | Body | Table header | Shrink floor | Page margin |
| --- | --- | --- | --- | --- |
| `document` | 7.5pt | 8pt | 6pt | 72pt |
| `statement` | 10pt | 10pt | 9pt | 72pt |
| `ledger` | 8.5pt | 9pt | 7.5pt | 40pt |
| `operational` | 9pt | 9.5pt | 8pt | 54pt |

Rules:

- `document` IS the legacy `accountantMono` theme and must stay identical
  to it — every transactional document (invoice, delivery note, statement,
  remittance advice) depends on it. A test asserts equality.
- `generateReportPdf` defaults to `document`. Profiles are OPT-IN, so
  regulator-pinned callers (`generate-tax-certificate`,
  `generate-statutory-return`, `generate-payroll-document`) are unchanged.
- Only `_shared/reports/renderReport.ts` selects a profile: from
  `ReportSpec.presentationProfile`, else `inferPresentationProfile(formatProfile, columnCount)`
  (financial → statement; >=7 columns → ledger; otherwise operational).
- Density is handled by reclaiming page gutter FIRST; shrinking numerals
  is the last resort and is floored per profile, never at 6pt for reports.
- On-screen `ReportTable` (14px body / 11px headers) is already legible
  and is deliberately not tied to these profiles.

Guards: `supabase/functions/_shared/pdf/__tests__/report-typography_test.ts`.
Audit: `docs/audit/2026-08-08-report-typography.md`.
