
# Payroll Reports — Enterprise Architecture Audit & Remediation Plan

This plan is deliberately audit-first. **Phase 1–4 are analysis; Phase 5 is implementation.** No files change until you approve.

---

## Phase 1 — Architectural Audit (findings)

### 1.1 The payroll reporting lifecycle we actually run

```text
compute-payroll ──► payslips + payslip_lines           (Payroll Engine)
        │
approve-payroll ──► payroll_runs.approved_at IS NOT NULL
        │
        ├──► payroll_liabilities        (Payroll Engine — canonical statutory obligation)
        ├──► payroll_remittances        (Statutory Remittances workflow — payment lifecycle)
        ├──► generate-statutory-return  (Localization Pack — filing artifact, stored in `documents/`)
        ├──► generate-tax-certificate   (Localization Pack — YE certificate artifact)
        ├──► post-payroll-gl ──► journal_entries       (Finance / GL)
        └──► audit_logs / payslip_events               (Audit)
```

Every report in the library is a *view over one of these stages*. The current implementation ignores which stage owns the truth and re-derives everything from `payslip_lines`, which is the root cause of the disconnect you observed.

### 1.2 Report-by-report analysis (with the actual data source they should read)

| Report | Business event / who opens it | Canonical source of truth | Current source in `payrollData.ts` | Status |
|---|---|---|---|---|
| Payroll Register | Payroll officer, immediately after Approval | `payslips` + `payslip_lines` | ✅ correct | OK |
| Payroll Summary | HR/Finance, per run | `payroll_runs` aggregate | ✅ correct | OK |
| Payroll Work Entries | Payroll officer, pre-approval reconciliation | `payroll_work_entries` | ✅ (extended handler) | OK |
| Employee Earnings | Employee/HR/manager — **YTD earnings history per component** | `payslips` + `payslip_lines` **pivoted per rule_code across periods** | ❌ Just a flat header dump (gross/ded/net per payslip) — this is Payroll Register again with fewer columns | **BROKEN — wrong semantic** |
| Branch Payroll Cost | Finance/BU manager | `payslips.branch_id` + employer lines | ✅ correct | OK |
| Department Payroll Cost | Finance/HR | `employees.department_id` + payslips | ✅ correct | OK |
| Payroll GL Posting | Accountant, after post-payroll-gl | `journal_entries` + `journal_entry_lines` where source=payroll_run | Handled in `payrollExtendedData.ts` | OK |
| Overtime | Manager | `payslip_lines` where rule maps to overtime | Regex on rule_code/label ("overtime|OT") — brittle | **WEAK — should read `payroll_rule_types.kind='overtime'`** |
| Payroll Variance | CFO/HR analytics | Two run totals, delta | Sorts by `pay_period_end` ascending — treats "previous run" as previous *by end date*, not previous *by same schedule*. Cross-schedule mixing possible. | **WEAK** |
| Employer Contributions | Finance, HR analytics | employer_amount lines | ✅ correct | OK |
| Statutory Liabilities | Compliance / accounting | **`payroll_liabilities` (canonical)** | ❌ `payslip_lines.category === 'statutory'` | **BROKEN — root cause proven below** |
| Payroll Audit Trail | Auditor | `payslip_events` / `audit_logs` | Handled in extended | OK |
| P9 / P9A / P10 / P10A / P10D / NSSF / SHIF / AHL / NITA / HELB / Ghana PAYE etc. | Compliance officer | Existing `generate-statutory-return` / `generate-tax-certificate` (pack-owned) | Registry rows exist but the viewer's preview does not delegate to the artifact — it tries to render a payslip-lines table | **BROKEN — preview kind is `statutory_form` but the dispatcher currently falls back to table** |

### 1.3 Root cause of "No data found" on Statutory Liabilities (proven)

```
SELECT category, COUNT(*) FROM payslip_lines GROUP BY category;
 statutory_employee   4
 statutory_employer   3
 earning              3
 deduction            1
 relief               1
```

`payrollData.ts` line 230:

```ts
if (l.category !== "statutory") continue;
```

**Zero rows in the entire database have `category = 'statutory'`.** The compute engine writes `statutory_employee` / `statutory_employer` / `income_tax`. This is a category-vocabulary drift: the classifier (`_shared/payslipClassifier.ts`) knows the real names, but the Statutory Liabilities builder doesn't.

**The deeper architectural bug behind the surface bug:** Statutory Liabilities has no business reading `payslip_lines` at all. `payroll_liabilities` is the canonical, closed-period, per-obligation table that Statutory Remittances files against. Reports should be a *view* over it, not a re-derivation. That is why Remittances/Returns can produce output while Reports shows "no data": they read different tables.

### 1.4 Root cause of Employee Earnings being useless

The report today returns `{ employee, period, gross, deductions, net_pay }` — one row per payslip. That is Payroll Register minus columns. An enterprise Employee Earnings report is a **pivot**: rows = employees, columns = earning components (Basic, HRA, Overtime, Bonus, …) across a chosen tax year, with YTD totals. What the users (accountant, HR, employee) actually ask is *"what did this person earn, broken down by pay component, over the year?"* — not "give me every payslip header again". Redesign, not query-fix.

### 1.5 Statutory reports duplicate the wrong thing

- Statutory Remittances = **workflow** (draft → generate → file → pay → reconcile). Owned by remittance workflow.
- Statutory Reports (P9, NSSF file, SHIF file, …) = **artifacts** produced by the same generators.
- Statutory Liabilities Report = **read-only view** over `payroll_liabilities`.

Today's viewer, when opening a pack-owned statutory report, does not call the canonical `generate-statutory-return` / `generate-tax-certificate` — it routes through the generic table preview which has no data source for these keys. The registry rows exist, the entry points exist, the wiring between them is missing.

### 1.6 Period selection is not payroll-native

Every report currently uses arbitrary `dateFrom`/`dateTo`. Enterprise payroll systems always offer a **payroll-aware primary selector** and demote free date range to advanced:

1. **Payroll Run** — for run-scoped reports (register, summary, variance, work entries, GL posting).
2. **Payroll Period / Month** — for statutory monthly returns (P10, NSSF, SHIF, AHL).
3. **Tax Year** — for certificates and annual reconciliations (P9, P10D, Employee Earnings YTD).
4. **Quarter** — analytics.
5. **Custom Date Range** — advanced fallback.

This must be a declared parameter on each definition (`parameters.period.kind`), not a global date-range prop.

### 1.7 Registry is under-modelled

`payroll_report_definitions` today carries `owner_kind`, `preview_kind`, `export_formats`, `category`. It is missing:

- `data_source` — the canonical stage this report reads (`payslips`, `payroll_liabilities`, `journal_entries`, `pack_artifact`, `payroll_remittances`, `audit_events`).
- `period_selector` — one of `run | month | quarter | tax_year | custom` (with the allowed set per report).
- `dependencies` — lifecycle preconditions (`payroll_approved`, `gl_posted`, `remittance_filed`). The library card should show "requires GL posting" instead of silently rendering empty.
- `artifact_generator` — for pack-owned reports, the edge function that produces the canonical artifact (`generate-statutory-return` / `generate-tax-certificate`) so the viewer delegates instead of re-rendering.

### 1.8 Enterprise comparison (extract, not imitate)

- **Workday** — reports are declarative datasets over "business objects" with a period-selector primitive. Users never type date ranges for payroll reports; they pick a Pay Group Period or Tax Year.
- **SAP SuccessFactors / SAP HCM** — separates *evaluations* (payroll engine output), *statutory reporting* (country versions / PY-XX), and *analytics*. Each has a distinct entry point but a single generator per document.
- **Oracle HCM** — Statutory Reporting Types + Legislative Data Groups; every statutory report is registered by a legislative pack (identical to our localization-pack contract).
- **Odoo Enterprise** — Payroll Reports = view; Statutory declarations = separate module; identical documents can be reached from either, but generated by one engine.
- **Dynamics 365 HR** — reports carry metadata (period, run, generated_by, version) surfaced above every render; matches our metadata band intent.

**Pattern we adopt:** registry-driven definitions, one canonical generator per artifact, payroll-native period selector, ownership rails, explicit lifecycle dependencies, artifact re-surfacing (not regeneration).

---

## Phase 2 — Architectural Inconsistencies (the list)

1. Statutory Liabilities reads the wrong table (`payslip_lines`) and the wrong category token (`'statutory'`), producing empty output on every real dataset.
2. Employee Earnings is semantically Payroll Register — not an earnings report.
3. Overtime uses regex over rule labels instead of `payroll_rule_types.kind`.
4. Payroll Variance mixes runs across schedules by end date.
5. Pack-owned statutory reports render into a generic table preview instead of delegating to `generate-statutory-return` / `generate-tax-certificate`.
6. Period selection is universally custom date range — non-native to payroll.
7. Registry lacks `data_source`, `period_selector`, `dependencies`, `artifact_generator`.
8. The Reports library does not communicate lifecycle preconditions ("payroll must be approved / GL must be posted / return must be filed") — users see empty results rather than "not ready".
9. Two truths for statutory numbers: `payslip_lines` (Reports) vs `payroll_liabilities` (Remittances). Only one can be canonical — `payroll_liabilities` wins.
10. No cross-schedule guard on payroll_period selection; date range lets users mix incompatible runs.

---

## Phase 3 — Proposed Enterprise Architecture

### 3.1 Layers

```text
                       ┌───────────────────────────────┐
                       │  Reporting Centre (UI)        │
                       │  Overview | Library | Sched.  │
                       │  | History                    │
                       └──────────────┬────────────────┘
                                      │
             registry-driven          │  reads
                                      ▼
                       ┌───────────────────────────────┐
                       │ payroll_report_definitions    │
                       │ + owner_kind                  │
                       │ + preview_kind                │
                       │ + data_source   (NEW)         │
                       │ + period_selector (NEW)       │
                       │ + dependencies  (NEW)         │
                       │ + artifact_generator (NEW)    │
                       └──────────────┬────────────────┘
                                      │ dispatch
              ┌───────────────────────┼────────────────────────┬─────────────────────┐
              ▼                       ▼                        ▼                     ▼
     Payroll Engine views    Finance / GL views       Compliance artifacts     Audit views
     (payslips,              (journal_entries,        (pack generators —       (payslip_events,
      payslip_lines,          journal_entry_lines)     one canonical            audit_logs)
      payroll_liabilities)                             per document)
```

### 3.2 Ownership rails (unchanged from ADR-0062, but now enforced)

- Payroll Engine · Cost & Finance · Compliance (Pack) · Management · Audit · HR

### 3.3 Canonical data-source contract (NEW)

Each definition declares one of:

- `payroll_engine.payslips`
- `payroll_engine.payslip_lines`
- `payroll_engine.payroll_liabilities`     ← Statutory Liabilities lives here
- `payroll_engine.payroll_work_entries`
- `finance.journal_entries`
- `pack_artifact.statutory_return`         ← delegates to `generate-statutory-return`
- `pack_artifact.tax_certificate`          ← delegates to `generate-tax-certificate`
- `remittance.payroll_remittances`
- `audit.payslip_events`

The viewer dispatches on `data_source` first, `preview_kind` second. No file in `src/` will branch on `report_key`.

### 3.4 Payroll-native period selector (NEW)

```ts
type PeriodSelector =
  | { kind: 'run';       required: true }
  | { kind: 'month';     required: true }
  | { kind: 'quarter'  }
  | { kind: 'tax_year' }
  | { kind: 'custom'   };   // fallback, always allowed
```

Each definition declares its **primary** selector and its **allowed** selectors. The viewer renders exactly the right selector — no more generic date range unless declared.

### 3.5 Lifecycle dependencies surfaced to users

- `payroll_approved` → visible on register/summary/statutory
- `gl_posted` → visible on payroll_gl_posting
- `remittance_filed` → visible on the "filing" cut of statutory reports

If a dependency is unmet, the library card shows a chip ("Waiting: GL not posted") and the viewer's empty state is *diagnostic*, not silent.

### 3.6 Statutory artifact delegation

Pack-owned reports (P9, P10, NSSF, SHIF, AHL, NITA, HELB, Ghana equivalents, …) do not re-render in the Reports viewer. The viewer calls the same edge function Statutory Remittances calls (`generate-statutory-return` / `generate-tax-certificate`) and previews the returned artifact. **One generator, two entry points.** Statutory Remittances remains the *workflow* view; Reports is the *catalog + re-access* view.

### 3.7 Employee Earnings redesigned

Preview kind = `matrix`. Rows = employees. Columns = earning `rule_code`s. Period = Tax Year (primary) or Payroll Run (secondary). Includes YTD totals per component and grand totals per employee. Source: `payslip_lines` where bucket = `earning` (via `payslipClassifier`, not string match).

### 3.8 Statutory Liabilities redesigned

Preview kind = `table` over `payroll_liabilities` grouped by `liability_type` and period, with columns: employee-side, employer-side, total, filed amount (join `payroll_remittances`), outstanding. This is the canonical truth, and it matches what Statutory Remittances shows — because both read the same table.

### 3.9 Overtime & Variance fixes

- Overtime: classify via `payroll_rule_types.kind = 'overtime'`, not regex.
- Variance: group by `pay_schedule_id`, then order within schedule.

---

## Phase 4 — Implementation Plan (staged)

Each phase ships independently, no big-bang.

### Phase 5a — Registry model extensions

Migration adds columns to `payroll_report_definitions`:

- `data_source text not null default 'payroll_engine.payslips'` (with CHECK against enum)
- `period_selector jsonb not null default '{"primary":"custom","allowed":["custom"]}'`
- `dependencies text[] not null default '{}'`
- `artifact_generator text` (nullable)

Backfill core definitions. Pack sync function updates `data_source='pack_artifact.statutory_return'` / `'pack_artifact.tax_certificate'` and `artifact_generator` accordingly.

### Phase 5b — Viewer dispatch by data_source

`PayrollReportViewer` learns to dispatch:

- `payroll_engine.*` → existing `render-report` path.
- `payroll_engine.payroll_liabilities` → new small builder over `payroll_liabilities` + `payroll_remittances`.
- `pack_artifact.statutory_return` → invokes `generate-statutory-return` (canonical), previews the returned bytes (CSV → tabular preview; PDF → embedded viewer).
- `pack_artifact.tax_certificate` → invokes `generate-tax-certificate`, previews PDF.

### Phase 5c — Fix Statutory Liabilities canonical source

Replace `payrollData.ts::statutory_liabilities` with a `payroll_liabilities` reader. Cross-join to `payroll_remittances` for filed/paid amounts. Metadata band shows the source table plainly.

### Phase 5d — Employee Earnings as YTD matrix

Rewrite the handler to produce a matrix (employees × earning components) over the selected tax year / run. Preview kind switched to `matrix`. Uses `payslipClassifier` for bucketing.

### Phase 5e — Overtime and Variance corrections

- Overtime handler joins `payroll_rule_types` on `rule_code` and filters `kind='overtime'`.
- Variance handler groups by `pay_schedule_id` before ordering.

### Phase 5f — Payroll-native period selector

Replace the global `ReportFilters` date-range with a period selector that reads the definition's `period_selector` and renders Run picker / Month picker / Tax Year picker / Custom Range. The centre landing keeps a coarse month-context; the viewer owns per-report period binding.

### Phase 5g — Lifecycle dependency chips

Library cards and viewer header show a "readiness" chip per declared dependency. RPC (`payroll_report_readiness(p_report_key, p_period)`) returns the dependency states so the UI is diagnostic on empty output.

### Phase 5h — Guardrails

- Vitest: `payroll_report_definitions` — every row has a `data_source`, and no `payroll_engine.*` handler references string literals for known-mismatched categories (`'statutory'`).
- Vitest: viewer must dispatch pack-owned reports through the canonical edge functions (source-level assertion, same style as the existing lifecycle-gate tests).
- Vitest: registry rows for pack-owned reports must have `artifact_generator` non-null.

### Phase 5i — Docs

Update `docs/adr/0062-payroll-reporting-centre.md` with §Data Sources, §Period Selector, §Dependencies, §Delegation. Add a `docs/manuals/hr-payroll/11-reporting-centre.md` capturing the ownership rails and the "one generator, two entry points" rule.

---

## Non-goals for this pass

- No visual redesign of the landing (Overview/Library layout stays).
- No new report types beyond the ones already registered.
- No changes to Statutory Remittances workflow.
- No changes to `compute-payroll` or `payslip_lines` schema.

---

## What I need from you before implementing

Nothing. If you approve this plan I will execute Phase 5a → 5i in order, opening one migration + code change per stage so each can be reviewed independently.
