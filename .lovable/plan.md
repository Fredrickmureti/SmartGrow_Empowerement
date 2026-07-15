
# Payroll Reports — Enterprise Reporting Centre

## Phase 1 — Architecture audit (what exists today)

The plumbing is stronger than the UI. Findings from the codebase:

- **Registry already exists.** `payroll_report_definitions` is a DB-backed
  registry consumed by `usePayrollReportDefinitions` — reports carry
  `report_key, label, description, category, scope, country_code,
  sort_order, feature_flag`. Categories today: `operational | cost |
  management | compliance | audit`. Country packs *can* publish rows
  without touching UI code. **Ownership is not modeled.**
- **Single render engine.** `supabase/functions/render-report/` +
  `_shared/reports/payrollData.ts` is the canonical builder. `Reports.tsx`
  is the only caller for payroll keys; exports flow through
  `ReportExportService` via `ReportPageLayout`. No duplicate generators.
- **Sibling domains are already separated.** `TaxCertificates.tsx` (owner:
  Localization pack via `generate-tax-certificate`) and Statutory
  Remittances workflow (`remittances`, `generate-statutory-return`) live
  outside Reports. That separation is correct and must be preserved — but
  the *reporting entry points* for those domains (Kenya P9, P9A, NSSF,
  SHIF, AHL, PAYE returns) are missing from the Reports centre and users
  have no discoverable path to them.
- **Localization packs already publish**: certificate templates + statutory
  return templates. They do **not** currently publish rows into
  `payroll_report_definitions`. That is the missing contract.
- **UI weaknesses in `src/pages/hr/payroll/Reports.tsx`:**
  1. One flat page: KPI strip + N `TabsList` chip groups + one table.
     No landing/browse layer, no report page of its own.
  2. Filters are date + branch only. Report parameters (period, run,
     employee, currency basis, version) are not first-class.
  3. Export formats are hardcoded in `ReportPageLayout` — a definition
     cannot declare "PDF + Official CSV only" (needed for NSSF/PAYE).
  4. Report metadata (generated-at, run ids, pack version, template
     version, filters used, employee count) is not surfaced or stamped
     onto exports.
  5. Preview strategy is fixed at "table". Registers, summaries,
     dashboards, certificates, statutory returns all render into the
     same table shell.
  6. No ownership badge, no source-of-truth link (e.g. "owned by Kenya
     Fiscal Pack v10.1.6 → Localization › Packs").
  7. No history / recent generations, no report subscriptions, no saved
     views — although `scheduled_reports` already exists.
  8. `groupPayrollReports` collapses everything under 5 category chips
     with no separation between core payroll and country-published rows.
     Adding 30 countries would produce an unusable chip wall.

## Phase 2 — Research findings (enterprise patterns worth adopting)

Common shape across Workday, SAP SuccessFactors, Oracle HCM, Odoo
Enterprise, Dynamics 365 HR:

- **Reporting Centre landing** — dashboard-first: current period status,
  last run, headcount, gross/net, statutory liability, blockers.
  Answers "what is happening in payroll" before "which report".
- **Library browser** — reports are cards/rows with metadata (owner,
  category, last run, favourite, description, formats), not tab chips.
  Filterable by owner/category/country/search. Infinitely scalable.
- **Report viewer as its own route** — opening a report is navigation,
  not tab state. Deep-linkable, back-button friendly. Each report
  declares its parameter set (period, run, employee, currency basis) and
  the viewer renders the appropriate preview (table, matrix, summary
  cards, statutory form facsimile, cert PDF preview).
- **Publisher model** — every report row declares an owner
  (`Payroll Engine`, `Localization Pack:KE`, `Finance`, `Audit`). A
  localization pack manifest contributes report definitions the same
  way it contributes templates today.
- **Export declaration** — each report advertises its supported outputs.
  Statutory returns advertise the *official* export as the primary
  action; PDF/CSV are secondary.
- **Report runs are records** — every generation writes a
  `payroll_report_runs` row: params, generated-by, generated-at, source
  runs, pack version, template version. Same table drives history +
  audit + re-export.

## Phase 3 — Proposed enterprise architecture

### Information architecture

```text
/hr/payroll/reports                     — Reporting Centre (landing)
  Overview               period health, KPI strip, blockers, recent runs
  Library                registry browser (search / owner / category / country)
  Scheduled              existing scheduled_reports surface (payroll scope)
  History                payroll_report_runs (my runs, all runs)
/hr/payroll/reports/:reportKey          — Report viewer (params + preview + export)
```

Categories become **owner-first, category-second** rails:

```text
Payroll Engine      → Register · Summary · Employee Earnings · Retro/Delta · Run Audit
Cost & Finance      → Employer Contributions · Branch Cost · GL Posting · Cost Center
Compliance (KE pack)→ P9 · P9A · PAYE Return · SHIF · NSSF · AHL · HELB
Compliance (…)      → published by each installed country pack
Management          → Trends · Distribution · Headcount × Cost
Audit               → Approvals · Overrides · Access · Mapping Changes
```

### Report ownership model (schema addition)

Extend `payroll_report_definitions`:

```text
owner_kind      enum: 'payroll_engine' | 'finance' | 'audit'
                     | 'localization_pack' | 'management' | 'hr'
owner_ref       text  -- pack code + version for localization; module id otherwise
preview_kind    enum: 'table' | 'summary' | 'matrix' | 'dashboard'
                     | 'statutory_form' | 'certificate'
export_formats  jsonb -- [{ format: 'pdf'|'csv'|'xlsx'|'official_csv'|'xml',
                --          label, isPrimary }]
parameters      jsonb -- declarative param schema (period, run, employee,
                --          currency_basis, comparison_period, filters)
metadata        jsonb -- pack_version, template_version, publisher notes
```

New tables:

```text
payroll_report_runs
  id, org_id, business_id, report_key, params_json,
  row_count, employee_count, generated_by, generated_at,
  pack_version, template_version, duration_ms, export_urls_json,
  source_payroll_run_ids uuid[]
```

`render-report` writes one row per generation. History + audit consume it.

### Localization pack contract

Pack manifests already publish templates. Extend the pack publisher
migration path so a pack contributes:

```text
- report definitions            → payroll_report_definitions
- report → template binding     → report_key ↔ statutory template / cert template
- parameter overrides           → fiscal_year, month, employee etc.
- export_formats                → declared per report (e.g. P9 = PDF+XLSX,
                                  NSSF = official CSV + PDF)
```

Un-installing a pack retracts its definitions. **No file in `src/`
mentions Kenya-specific report keys.** The current
`payrollData.ts` builders for `payroll_register / payroll_summary /
employer_contributions / statutory_liabilities / employee_earnings /
branch_payroll_cost` remain owned by `payroll_engine`. Country reports
(P9, NSSF, …) resolve through the existing statutory/certificate engines,
not new generators.

### Report lifecycle

```text
Definition (registry row, owner-declared)
   ↓
Discovery  (Library / Overview surfaces show it)
   ↓
Parameter binding (viewer collects declared params)
   ↓
Generation (render-report → engine dispatch by owner_kind)
   ↓
Preview    (preview_kind decides the surface)
   ↓
Export     (export_formats decides the actions)
   ↓
Run record (payroll_report_runs; feeds History + Scheduled + Audit)
```

### Preview model

Dispatch by `preview_kind`:

- `table` — current tabular renderer (register, earnings, cost).
- `summary` — grouped KPI + subtotal cards (Payroll Summary,
  Employer Contributions).
- `matrix` — pivot (Branch × Rule, Department × Month).
- `dashboard` — analytical (trends, distribution).
- `statutory_form` — form facsimile preview using the statutory template
  engine (already used by remittances).
- `certificate` — PDF preview via `generate-tax-certificate` (already
  used by TaxCertificates).

### Export model

Each report definition declares its supported outputs. `ReportPageLayout`
consumes `definition.exportFormats` instead of hardcoding. Official
statutory outputs are surfaced as the *primary* action; convenience
formats collapse into a menu.

### Report metadata model

Every viewer displays and every export stamps:

```text
Report · Owner · Pack/Template version
Period · Payroll Run(s) · Filters
Generated at · Generated by
Employee count · Row count · Currency basis
```

Persisted in `payroll_report_runs`; rendered in a metadata band above
the preview and in export headers/footers.

## Phase 4 — Implementation plan

Backend-first, then UI. Each step is independently shippable.

**Step 1 — Registry hardening (migration).**
Add `owner_kind`, `owner_ref`, `preview_kind`, `export_formats`,
`parameters`, `metadata` columns to `payroll_report_definitions`.
Backfill existing 6 core rows as `owner_kind='payroll_engine'`,
`preview_kind='table'`, `export_formats=[pdf,csv,xlsx]`. Pin
via pgTAP contract test in `supabase/tests/`.

**Step 2 — `payroll_report_runs` table + writer.**
Migration + GRANT + RLS. `render-report` writes a run row on success.
Contract test for the columns.

**Step 3 — Localization pack publisher.**
Extend the pack apply/upgrade path (existing statutory/certificate
publisher migrations) to also insert `payroll_report_definitions` rows
declared by the pack. Retract on uninstall. Kenya pack publishes: P9,
P9A, PAYE Monthly, SHIF, NSSF Tier I/II, AHL, HELB — each pointing at
the existing statutory/certificate template it already ships. No
hardcoded Kenya knowledge in `src/`.

**Step 4 — Report viewer route.**
New route `/hr/payroll/reports/:reportKey` rendered by a
`PayrollReportViewer` that:
- resolves the definition from the registry,
- renders declared parameters (period picker, run picker, employee
  picker, currency basis) via a small param-schema renderer,
- dispatches to the right preview component by `preview_kind`,
- renders the metadata band,
- surfaces `export_formats` from the definition.

**Step 5 — Reporting Centre landing.**
`/hr/payroll/reports` becomes tabs: Overview | Library | Scheduled |
History. Overview keeps `PayrollReportsKpiStrip` and adds current
period status, blockers (reuses readiness summary), last run, recent
report runs. Library is a searchable grid grouped by owner rail
(Payroll Engine, Finance, Compliance:KE, Management, Audit). Scheduled
reuses `scheduled_reports` filtered to the payroll scope. History reads
`payroll_report_runs`.

**Step 6 — Retire the tab-chip page.**
`Reports.tsx` becomes the Overview tab shell; the old chip picker is
removed. Deep-links to any known `report_key` keep working via the new
viewer route (backward compatible).

**Step 7 — Preview components.**
- `TablePreview` — extract current tabular renderer verbatim (no
  business-logic change).
- `SummaryPreview`, `MatrixPreview`, `DashboardPreview` — additive,
  used only where the definition asks for them.
- `StatutoryFormPreview` and `CertificatePreview` — thin adapters that
  delegate to the existing statutory/certificate engines.

**Step 8 — Metadata + export stamping.**
`ReportPageLayout` reads `exportFormats` from the active definition;
export headers/footers include the metadata band contents.

**Step 9 — Guards + tests.**
- pgTAP: new columns/table pinned; pack-publish contract test asserting
  that installing Kenya pack contributes ≥ N statutory rows and
  uninstalling retracts them.
- Vitest: architecture guard forbidding string-literal statutory report
  keys (`P9`, `NSSF`, …) in `src/` outside `src/features/localization/`;
  guard forbidding hardcoded `export_formats` in the viewer.
- Playwright: land on Reporting Centre → open Library → open Payroll
  Register → change period → export PDF; capture screenshots.

### Backward compatibility

- Existing `payroll_register / …` report keys keep working; only the
  UI shell around them changes.
- `render-report` payload contract is unchanged; new columns are
  purely additive.
- The old page URL (`/hr/payroll/reports`) still resolves; the deep-link
  the previous UI generated (tab state) is replaced by the viewer route
  and a soft redirect from the legacy query.

### Risks & mitigations

- **Pack migration risk** — publisher extension touches every installed
  country. Ship as an idempotent upgrade migration; pgTAP + rollback
  block. Bump Kenya pack version to force clean re-apply per the
  existing pack upgrade flow (`docs/adr — 0056 localization-publisher-parity`).
- **Registry drift** — architecture test forbids new hardcoded report
  keys and export lists in components.
- **Scope creep into Statutory Remittances workflow** — Reports centre
  *lists and previews* statutory returns; *filing/lodging* remains in
  the Remittances workflow. Both call the same generator; neither owns
  it. Documented as ADR-0062 (new).

## Phase 5 — Implementation

Executed in the order above after this plan is approved. Each step
lands as its own commit series with tests, migrations bumped to
Kenya pack `10.1.7+`, and the ADR that documents the ownership +
publisher contract.

## Technical appendix

- Files touched:
  - `supabase/migrations/*_payroll_report_definitions_enrichment.sql`
  - `supabase/migrations/*_payroll_report_runs.sql`
  - `supabase/migrations/*_kenya_pack_publishes_reports.sql`
  - `supabase/functions/render-report/index.ts` (write run record)
  - `supabase/tests/payroll_report_definitions_contract_test.sql`
  - `supabase/tests/payroll_report_runs_contract_test.sql`
  - `src/hooks/payroll/usePayrollReportDefinitions.ts` (new fields)
  - `src/hooks/payroll/usePayrollReportRuns.ts` (new)
  - `src/pages/hr/payroll/reports/ReportingCentre.tsx` (new landing)
  - `src/pages/hr/payroll/reports/PayrollReportViewer.tsx` (new)
  - `src/pages/hr/payroll/reports/panels/{Overview,Library,History}.tsx`
  - `src/pages/hr/payroll/reports/previews/{Table,Summary,Matrix,Dashboard,StatutoryForm,Certificate}Preview.tsx`
  - `src/pages/hr/payroll/Reports.tsx` → thin re-export for BC
  - `src/apps/hr/sub/PayrollRoutes.tsx` (nested viewer route)
  - `src/test/architecture/no-hardcoded-statutory-report-keys.test.ts`
  - `docs/adr/0062-payroll-reporting-centre.md`
- No changes to: `generate-tax-certificate`, `generate-statutory-return`,
  `payrollData.ts` builders, remittance workflow, existing pack template
  publishers.
