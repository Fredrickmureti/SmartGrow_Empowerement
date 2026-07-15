# ADR-0062 — Payroll Reporting Centre

Status: Accepted · 2026-07-15

## Context

The Payroll Reports page was architecturally a list of category-grouped
tab chips over a single table renderer. It carried five problems that
cannot be fixed by re-styling:

1. **No information architecture.** All reports lived on one page.
   Adding 30 countries × their statutory reports would produce an
   unusable chip wall.
2. **No report ownership.** The registry did not model who owns a
   report (Payroll Engine, Cost & Finance, Localization Pack, Audit).
3. **One preview strategy.** Registers, summaries, dashboards,
   statutory forms and certificates all rendered into the same table.
4. **Hardcoded exports.** Export formats were baked into the layout;
   the registry could not declare "PDF + Official CSV only".
5. **No history.** Every generation was volatile — no `report_runs`
   record for audit, re-export or scheduled fan-out.

The Statutory Remittances workflow and the Tax Certificates surface
already own filing/lodging and certificate issuance respectively; the
Reports centre must surface them as reports without duplicating those
generators.

## Decision

Payroll Reports is a **Reporting Centre**, not a page. It is composed of:

- A landing (Overview | Library | Scheduled | History) at
  `/hr/payroll/reports`.
- A dedicated **viewer route** per report at
  `/hr/payroll/reports/:reportKey` that owns parameter binding,
  preview dispatch, metadata band, and export.
- The **registry** `payroll_report_definitions` extended with:
  `owner_kind`, `owner_ref`, `preview_kind`, `export_formats`,
  `parameters`, `metadata`.
- A **history table** `payroll_report_runs` written by the viewer on
  every successful generation.
- A **preview dispatcher** keyed on `preview_kind`
  (table | summary | matrix | dashboard | statutory_form | certificate).
- A **localization pack contract**: packs contribute their statutory
  reports as registry rows. No file in `src/` mentions country-specific
  report keys.

## Invariants

1. **Registry-driven.** The Reports centre never hardcodes report keys,
   labels, categories, previews or export formats. All are read from
   `payroll_report_definitions`.
2. **Ownership is explicit.** Every definition has an `owner_kind`; the
   library groups by owner rail.
3. **One canonical generator per report.** `render-report` remains the
   only builder for payroll data reports. Statutory forms and
   certificates delegate to their existing engines
   (`generate-statutory-return`, `generate-tax-certificate`).
4. **Every generation is a record.** `payroll_report_runs` receives one
   row per successful (and, in a follow-up, per failed) render.
5. **Localization packs publish, they do not hardcode.** Country
   statutory reports (P9, P9A, PAYE, NSSF, SHIF, AHL, …) surface only
   because a pack inserted rows into `payroll_report_definitions`.
6. **Tenant-scoped discovery.** The Reports centre never reads
   `payroll_report_definitions` directly. It calls the security-definer
   RPC `payroll_report_definitions_for_tenant(org, business)` which
   joins the registry against `installed_localization_packs` — a report
   whose owning pack is not installed is invisible to that tenant. A
   Kenya workspace CANNOT see Ghana's SSNIT / PAYE reports, regardless
   of `country_code` on the business. Regression guard:
   `src/test/payroll/reports-tenant-scoping.test.ts` forbids direct
   table reads and any `country_code` filter in the reports UI.
7. **Lifecycle-aware defaults.** When a report declares
   `payroll_approved` as a dependency, the viewer snaps the initial
   `dateFrom` / `dateTo` to the latest approved payroll run's
   `pay_period_start` / `pay_period_end`. The current calendar month is
   never a safe default for approval-gated reports — mid-month it
   yields empty output even when data exists.

## Consequences

- The old `Reports.tsx` becomes a backward-compat re-export of the
  Reporting Centre. Any bookmarks to `/hr/payroll/reports` keep
  working.
- New reports need no UI change — only a registry row.
- Uninstalling a country pack retracts its reports from the library
  automatically.

## Follow-ups (out of scope for this ADR)

- Pack publisher migration that contributes report definitions from
  Kenya (and other installed packs) with proper export format
  declarations (`official_csv` for NSSF, `xml` for PAYE).
- Scheduled report creation from the viewer.
- Rich matrix/pivot preview.
- Failure records + retry from the History tab.
