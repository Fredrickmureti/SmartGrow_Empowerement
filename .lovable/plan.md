# Payroll Reports — Architecture Audit & Remediation

## Phase 1 — Architecture Map (as-built today)

```text
UI: /hr/payroll/reports  (src/pages/hr/payroll/reports)
    ├── ReportingCentre.tsx        tabs: Overview | Library | Scheduled | History
    ├── panels/OverviewPanel       reads usePayrollReportDefinitions + usePayrollReportRuns
    ├── panels/LibraryPanel        reads usePayrollReportDefinitions, groupByOwner
    └── PayrollReportViewer.tsx    /hr/payroll/reports/:reportKey
             │
             ▼
Frontend catalogue hook
    src/hooks/payroll/usePayrollReportDefinitions.ts
      SELECT * FROM payroll_report_definitions WHERE is_active
      client-side filter: (!r.country_code || !ctx || r.country_code === ctx)
      ctx = currentBusiness.country_code  ← ONLY signal used
             │
             ▼
Registry table (GLOBAL, no tenant scoping columns)
    payroll_report_definitions
      built-in rows (country_code = NULL, owner_kind = payroll_engine/finance/…)
      pack rows    (country_code = 'KE' | 'GH' | …, owner_kind = 'localization_pack',
                    localization_pack_id, owner_ref → template)
             ▲
             │ populated by
    payroll_report_definitions_sync_from_packs()
      Iterates EVERY row of localization_packs (not installed_localization_packs).
      Every pack that exists in the platform → its templates become rows here.
             │
             ▼
Renderer / artifact engines
    render-report                (payroll engine data reports)
    generate-statutory-return    (pack-owned returns)
    generate-tax-certificate     (pack-owned certificates)

Installed-pack truth (NEVER consulted by the reports UI)
    installed_localization_packs  (organization_id, business_id, pack_id, pack_version)
```

## Phase 2 — Report Discovery, Evidenced

The reports page discovers reports **only** via
`payroll_report_definitions`. Evidence: `src/hooks/payroll/usePayrollReportDefinitions.ts:203-213`
is the sole query. `installed_localization_packs` is not read anywhere
under `src/pages/hr/payroll/reports/` (`rg` confirmed).

- Reads every active row (built-in + all pack-published).
- Does NOT read `installed_localization_packs`.
- Merges built-in and pack rows via one `SELECT`, then filters by
  `country_code` string against `currentBusiness.country_code`.
- No feature flags, no per-tenant scoping, no ownership scoping.

## Phase 3 — Root Cause of Ghana Reports Showing in Kenya

Two independent defects compound:

1. **Registry is not tenant-scoped.** `payroll_report_definitions` has no
   `organization_id` / `business_id`. `sync_from_packs()`
   (migration `20260715142251_…`) fans out **every** pack in
   `localization_packs` — including the Ghana skeleton pack seeded by
   `20260601110615_…` — into global rows. Any tenant reading the table
   sees every country's pack reports.
2. **Country filter is weak and wrong-signal.** In
   `usePayrollReportDefinitions` the filter is
   `!r.country_code || !countryCode || r.country_code === countryCode`.
   When `currentBusiness.country_code` is `null`/undefined (the common
   case — `businesses.country_code` is not required on setup), the
   short-circuit `!countryCode` returns **every** row including Ghana.
   Even when the field is populated, using the business's country
   attribute — not the set of packs the tenant installed — is the wrong
   invariant: a Kenya business could install a Ghana pack, or a
   multi-country org could install several.

The correct invariant: a pack-owned report is visible **iff** its
`localization_pack_id` appears in `installed_localization_packs` for the
current (organization_id, business_id). Built-in rows
(`owner_kind ≠ 'localization_pack'`, `country_code IS NULL`) are always
visible.

## Phase 4 — Empty-Report Root Causes

Reviewed viewer + panels:

- The viewer dispatches all non-pack reports to
  `render-report` with `dateFrom = startOfMonth(now)`, `dateTo = endOfMonth(now)`.
  It never resolves a **payroll run** or **payroll period**, so
  `payroll_register`, `payroll_summary`, `employee_earnings`,
  `statutory_liabilities` and `employer_contributions` return empty
  when the current calendar month has no approved run (typical
  mid-month).
- No lifecycle-aware messaging: a report gated on
  `payroll_approved` (see `dependencies` column) shows "No data"
  instead of "No approved payroll run in this period — open Payroll →
  Approvals".
- `statutory_liabilities` never surfaces already-generated returns from
  `payroll_remittances` / `payroll_return_runs` — it only re-queries
  `payroll_liabilities` through `render-report`.
- Certificates panel (`PackArtifactPanel`) is fine when a period is
  chosen but has no "latest tax year" default.

## Phase 5 — Ownership & Localization Model (target)

Two report classes, hard-separated in the registry:

- **Platform reports** — `owner_kind ∈ {payroll_engine, finance,
  management, audit, hr}`, `country_code IS NULL`,
  `localization_pack_id IS NULL`. Always visible.
- **Localization reports** — `owner_kind = 'localization_pack'`,
  `country_code NOT NULL`, `localization_pack_id NOT NULL`. Visible
  **only** if `(org, business)` has that `pack_id` in
  `installed_localization_packs`.

The registry stays global (single source of truth for definitions), but
**visibility is derived per tenant** via a security-definer RPC that
joins to `installed_localization_packs`. Client code stops filtering by
`country_code`.

## Phase 6 — Business-Event Lifecycle Mapping

The `dependencies` column already models this (`payroll_approved`,
`gl_posted`, `remittance_filed`) and `payroll_report_readiness` RPC
already exists (migration `20260715142251`). The UI currently ignores
readiness for empty-state messaging and for period defaulting. The plan
wires it in.

Event → newly-available reports:

```text
run approved       → register, summary, employee_earnings,
                     employer_contributions, statutory_liabilities,
                     pack returns, pack certificates
GL posted          → payroll_gl_posting, branch/department cost
remittance filed   → statutory_liabilities (now with filed status),
                     audit trail entries
```

## Phase 7 — Enterprise IA (adopted principles, not copied UI)

From Workday / Oracle HCM / SAP SuccessFactors / Odoo / Dynamics 365 the
consistent principles are: (a) reports have declared **owners** and
**data domains**; (b) statutory/country reports are contributed by
country extensions and appear only when the extension is enabled for
the legal entity; (c) each report declares its **required upstream
event** and the shell communicates readiness; (d) generated artifacts
are first-class ("Latest run" surfaces before "Run new"). Our existing
registry columns (`owner_kind`, `dependencies`, `preview_kind`,
`export_formats`) already support this — the fix is scoping + surfacing,
not new columns.

---

## Implementation Roadmap

### R1. Tenant-scoped visibility (blocks the leak) — DB

Add a security-definer RPC `payroll_report_definitions_for_tenant(p_org uuid, p_business uuid)` that returns:

- every active row where `owner_kind <> 'localization_pack'`, plus
- every active row where `owner_kind = 'localization_pack'`
  AND `localization_pack_id IN (SELECT pack_id FROM installed_localization_packs WHERE organization_id = p_org AND (business_id = p_business OR business_id IS NULL))`.

No changes to `payroll_report_definitions` shape. Grants: `authenticated, service_role`.

### R2. Frontend catalogue — replace filter with RPC

`usePayrollReportDefinitions` stops taking `countryCode`, takes
`(orgId, businessId)`, and calls the RPC. Callers in
`LibraryPanel`, `OverviewPanel`, `PayrollReportViewer` updated
accordingly. Remove the `!r.country_code || …` client filter entirely.

### R3. Viewer 404-on-unavailable

If the RPC does not return the requested `:reportKey`, the viewer
renders a "This report is not available for the current company —
install the country pack in Localization to enable it" state instead
of an empty preview. Prevents deep-link bypass.

### R4. Lifecycle-aware empty states & defaults

- Viewer default period: for reports depending on `payroll_approved`,
  default `dateFrom/dateTo` to the last approved run's period (query
  `payroll_runs` ordered by `approved_at desc limit 1`) instead of the
  current calendar month.
- Empty-state text driven by `payroll_report_readiness`: e.g. "No
  approved payroll run in this period" with a link to
  `/hr/payroll/approvals`.
- `statutory_liabilities` preview: augment `render-report` result
  with the matching `payroll_remittances` / `payroll_return_runs`
  rows so filed artifacts are downloadable inline. (Preview-level
  augmentation only — no changes to the generators.)

### R5. Regression guards (architecture tests)

Add three tests under `src/test/payroll/`:

1. **DB test** (pgTAP or SQL-in-vitest): calling
   `payroll_report_definitions_for_tenant` for an org with only the KE
   pack installed returns zero rows where `country_code = 'GH'`.
2. **Source guard**: `rg` fails the build if any file in
   `src/pages/hr/payroll/reports/` or
   `src/hooks/payroll/usePayrollReportDefinitions*.ts` references
   `payroll_report_definitions` directly (must go through the RPC).
3. **Source guard**: the sync function name
   `payroll_report_definitions_sync_from_packs` is only referenced
   from migrations and pack-install/uninstall handlers — never from
   `src/`.

### R6. Docs

Update `docs/adr/0062-payroll-reporting-centre.md` with a new
"Invariant 6: pack-owned reports are scoped by
`installed_localization_packs`, not by `businesses.country_code`" and
link to the RPC.

---

## Deliverables Checklist

- [ ] Architecture map (this doc)
- [ ] Root cause: Ghana in Kenya = global registry + weak country filter
- [ ] Root cause: empty reports = calendar-month default + no readiness surfacing
- [ ] Ownership model: platform vs localization, enforced via `installed_localization_packs`
- [ ] Localization isolation via new RPC (R1) + UI switch (R2, R3)
- [ ] Lifecycle wiring (R4) using existing `dependencies` + `payroll_report_readiness`
- [ ] Enterprise comparison summarised (Phase 7)
- [ ] Regression guards (R5)
- [ ] ADR-0062 invariant (R6)

Non-goals for this phase: rich matrix/pivot preview, scheduled reports
from viewer, failure records + retry — deferred (already listed as
follow-ups in ADR-0062).