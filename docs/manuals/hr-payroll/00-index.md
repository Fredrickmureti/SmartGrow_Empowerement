# HR, Payroll & Localization Platform — Operational Manual

> **Audience:** Business owners · accountants · payroll officers · HR managers · implementation consultants · future engineers.
> **Scope:** End-to-end coverage of HR, Payroll, Localization Packs, Employee Self-Service, Payroll Accounting, Statutory Remittances, and Payroll Documents as they exist in this codebase today.
> **Status:** Source-of-truth manual. Every claim is traceable to a `file:line`, `table.column`, edge function, or RPC. Unverifiable behavior is explicitly tagged **UNVERIFIED**.

This manual is split into focused chapters. Read sequentially for a first pass; thereafter use the persona reading paths below to jump to the chapters that matter for your role.

## Chapters

| # | File | What it covers |
|---|---|---|
| 01 | [Architecture Overview](./01-architecture-overview.md) | Module map, ownership boundaries, key edge functions, ADR references |
| 02 | [HR Employee Lifecycle](./02-hr-employee-lifecycle.md) | Create → invite → activate → state changes → exit |
| 03 | [Org Structure](./03-org-structure.md) | Departments, positions, locations, contracts, compensation history |
| 04 | [Attendance, Leave, Timesheets](./04-attendance-leave-timesheets.md) | Capture, approvals, integration into payroll |
| 05 | [Localization Packs](./05-localization-packs.md) | Publisher → version → install → upgrade → consumption |
| 06 | [Payroll Setup](./06-payroll-setup.md) | Pay schedules, salary structures, rules, statutory identifiers, GL mapping |
| 07 | [Payroll Run Lifecycle](./07-payroll-run-lifecycle.md) | Readiness → draft → compute → approve → post → pay → close → reverse |
| 08 | [Payroll Accounting](./08-payroll-accounting.md) | Every JE event, account roles, drift monitoring |
| 09 | [Statutory Remittances & Certificates](./09-statutory-remittances-certificates.md) | Accrue → schedule → pay → allocate → certificate |
| 10 | [Payroll Documents](./10-payroll-documents.md) | Payslip & certificate PDF pipelines, immutability, portal exposure |
| 11 | [Employee Self-Service Portal](./11-employee-portal.md) | Invitation, auth, what the employee sees and can do, PII masking, SoD |
| 12 | [Walkthrough — Apex Traders](./12-walkthrough-apex-traders.md) | End-to-end simulated month: signup → pack → employees → run → posting → certificate |
| 13 | [Production Readiness](./13-production-readiness.md) | Per-subsystem rating + comparative notes vs Odoo / Workday / SAP SF / Oracle HCM / ADP / UKG |
| 14 | [Glossary & Data Dictionary](./14-glossary-and-data-dictionary.md) | Terms + compact data dictionary for the ~80 HR/payroll/localization tables |

## Recent additions (2026-06-19)

- **Contract-first proration** — `employee_contracts.start_date` is the authoritative employment-window start; `employees.hire_date` is HR/tenure metadata and is overridden when it post-dates the contract.
- **`payroll_runs.period_id`** — Optional FK to `payroll_periods`. When supplied the engine derives the window and refuses locked/closed periods. A non-overlap exclusion constraint prevents duplicate windows per `(business_id, period_type)`.
- **Employee advances (first-class)** — `employee_advances` + `advance_repayment_schedule`. Recovered by `compute-payroll` after loans and before garnishments, honoring per-advance `min_net_floor`.
- **Settings consolidation** — Standard working days / hours / OT multiplier read via `v_payroll_settings_effective`. The `businesses.payroll_standard_*` columns are DEPRECATED but retained for one release.
- **Deprecated tables** — `payroll_remittances` and `employments` (use `payroll_liabilities` + `payroll_remittance_payments` and `employee_contracts` instead).

## Persona reading paths

- **Accountant (period-close & audit):** 01 → 08 → 09 → 10 → 12 → 13.
- **Payroll Officer (run a payroll end-to-end):** 06 → 07 → 09 → 10 → 11 → 12.
- **HR Manager (onboard, retain, exit people):** 02 → 03 → 04 → 11 → 13.
- **Implementation Consultant (set up a new tenant):** 01 → 05 → 06 → 09 → 12 → 13.
- **Engineer (maintain or extend):** 01 → relevant domain chapter → 13 → research notes under `_research/`.

## How to use this manual

1. **Trust, but verify.** Every chapter cites `file:line`, table names, RPCs, and edge functions. Open the cited code if anything looks wrong.
2. **Look for UNVERIFIED tags.** These mark behaviors we could not confirm by direct code read. Confirm before relying on them in production.
3. **Risks are deferred to Chapter 13** so domain chapters stay operational.
4. **Detailed working notes** for each domain live under `./_research/` and are the source the chapters were distilled from.

## Conventions

- File paths are relative to repo root.
- `Dr`/`Cr` are double-entry debit/credit in the General Ledger.
- "Statutory" = anything required by a tax authority (PAYE, social security, levies, etc.). The platform is **country-agnostic**: country shows up only as data inside Localization Packs (ADR-0036).
- "Pack" = Localization Pack — a versioned bundle of country-specific tax rules, identifiers, accounts, and statutory document templates.
- "Run" = a single payroll execution (`payroll_runs` row). May be `regular`, `off_cycle`, `bonus`, `commission`, `13th_month`, `termination`, `supplemental`, or `correction`.
