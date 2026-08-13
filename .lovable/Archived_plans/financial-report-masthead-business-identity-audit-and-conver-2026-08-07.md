# Financial Report Masthead & Business Identity — Audit and Convergence

## A. What the investigation found (evidence)

Both Trial Balance and Cash Flow render through the *same* pipeline:

```text
report page → getExportConfig() → ReportExportService → render-report (PREBUILT mode)
  → renderReport() → generateReportPdf() → drawBrandedHeader()
```

The divergence is not in the header component. It is in **what the page tells
the pipeline about itself**.

- `src/pages/reports/CashFlowReport.tsx:124-134` passes `reportType: "cash_flow"`.
- `src/pages/reports/TrialBalance.tsx:206-217` passes **no `reportType`** (it also
  passes no `companyName`).

Downstream consequence:

- `renderReport` (`supabase/functions/_shared/reports/renderReport.ts:103,115`)
  looks the report up in the registry. No `reportType` → `spec = null` →
  `formatProfile` falls back to `"operational"`.
- `supabase/functions/_shared/reportPdfGenerator.ts:129-131`:
  `const needsLogo = formatProfile !== "financial"` — the **financial masthead
  omits the logo by design** ("statutory reports lead with the legal entity
  name, not branding", `BrandedHeader.ts:41-47`).
- The registry pins `trial_balance`, `cash_flow`, `pnl`, `balance_sheet`,
  `general_ledger` all to `formatProfile: "financial"`
  (`_shared/reports/columnSpecs.ts:74,79,94,104,114`).

## B. Root cause (G)

Trial Balance does **not** receive "the expected dynamic branding" by design —
it receives the **operational fallback header** because it silently fails
registry lookup. Cash Flow is the report that is behaving as the architecture
currently specifies. So:

1. The visible symptom is an **accidental** difference caused by an optional
   `reportType` field on a client-built export config.
2. The underlying architectural decision — "financial masthead has no logo" —
   is the thing that is actually wrong for an enterprise ERP. SAP, Oracle EBS/
   Fusion, Dynamics, NetSuite and Odoo all render statement letterheads with
   the legal entity's logo plus legal name, period, basis and scope; branding is
   part of document identity, not decoration.

Same-shape drift elsewhere (verified): `TrialBalance`, `FinancialReports` (P&L /
Balance Sheet), `BankReconciliationReport`, `Consolidation`,
`ControlAccountReconciliation`, `FxRevaluation` also ship export configs with no
`reportType`. **No** report page passes `businessId`, and **no** page uses
`enrichExportConfig()` from `src/contexts/ReportContext.tsx`.

## C/D. Identity and logo provenance

| Value | Actual source today | Verdict |
| --- | --- | --- |
| PDF company name / logo / address / tax id | `getOrganizationBranding()` → `businesses` row (`logo_url` etc.), branch overrides via `get_effective_company_config` | Canonical resolver exists and is correct |
| …but which business? | `renderReport.ts:153` calls it with **`organizationId` only**, dropping the `businessId`/`branchId` it already holds → resolver falls back to "oldest active business" | **Multi-company defect** |
| Screen company name (`ReportSurface`) | `currentOrg?.name` (tenant org) in both pages | Wrong entity; should be the business |
| Screen logo | not rendered at all | Screen ≠ PDF |
| Report title | page literal, or registry `getReportTitle()` when `reportType` is sent | Dual source |
| Period / as-of | page-formatted string in `dateRange` | Report-specific dynamic (acceptable, but should be structured) |
| Scope line ("Business · Branch (HQ)") | composed ad hoc per report | Should be derived once from resolved identity |
| Generated stamp / run hash | `PdfBuilder` + `computeRunHash` | Canonical |

No hardcoded tenant name, branch name or logo URL was found in report code.

## E. Target architecture

One resolved document context, produced **server-side, once**, in `renderReport`:

```text
ReportDocumentContext
├── BusinessIdentity   (from getOrganizationBranding(org, business, branch))
│     name / legal_name / logo / address / tax id / currency
├── ReportIdentity     (registry-owned + call-owned)
│     reportKey · title · subtitle(basis) · period|asOf · scope · generatedAt · runHash
└── ReportPresentation (registry-owned)
      formatProfile · presentationProfile · orientation · paper
```

Pages contribute **data and parameters only** — never identity strings.

## F. Changes

1. **`_shared/reports/renderReport.ts`** — pass `businessId` and `branchId` into
   `getOrganizationBranding` so the correct legal entity (and branch override)
   is resolved in multi-business tenants.
2. **Financial masthead gains identity branding** — in `reportPdfGenerator.ts`
   the logo is embedded for both profiles; `drawFinancialMasthead` renders a
   small centered logo above the legal name, then Title → Period/As-of →
   Basis → Scope → Prepared on. Typography/presentation profiles
   (`themes/presentation.ts`) are untouched — no new theme, no second header
   system; `BrandedHeader` stays the single masthead.
3. **Scope line becomes derived** — `renderReport` composes
   `"<business> · <branch>"` from the resolved identity and passes it to the
   masthead as a distinct field, instead of each report improvising a subtitle.
   `subtitle` stays for the accounting basis ("Accrual basis", "Indirect method").
4. **Close the client contract hole** — `ExportConfig.reportType` becomes
   required for finance report pages; add `businessId`/`branchId`. Every finance
   report page's `getExportConfig` routes through `enrichExportConfig()` so
   org/business/branch/currency are injected by `ReportContext`, and pages stop
   passing `companyName`.
5. **Screen == paper** — `ReportSurface` takes identity from `ReportContext`
   (business name + logo + scope) rather than each page passing
   `currentOrg?.name`, and renders the logo, matching the new PDF masthead.
6. **Registry completeness** — add registry entries (or explicit
   `formatProfile`) for the finance reports currently falling through:
   Bank Reconciliation, Consolidation, Control Account Reconciliation,
   FX Revaluation, plus P&L / Balance Sheet in `FinancialReports.tsx`.

Out of scope, untouched: report calculation logic, `render-report` transport,
CSV/XLSX writers, printing/print-policy/ESC-POS/ZPL/hardware, certificate
engine, payroll/sales/inventory/HR/POS report surfaces.

## J. Regression strategy

- Deno tests in `_shared/pdf/__tests__`: financial masthead emits logo when
  `logo_url` present, degrades cleanly when absent or un-embeddable; operational
  header unchanged; typography tokens per profile unchanged (existing
  `report-typography_test.ts` must still pass).
- Unit test: `renderReport` forwards `businessId`/`branchId` to the branding
  resolver; two businesses in one org resolve to different identities.
- Architecture test under `src/test/architecture/`: no report page passes
  `companyName`/hardcoded identity, and every finance report export config
  carries a registry-known `reportType`.
- Manual pass on Trial Balance, Cash Flow, P&L, Balance Sheet, General Ledger:
  one masthead shape, correct business, correct branch scope, correct
  period/as-of wording per report.
