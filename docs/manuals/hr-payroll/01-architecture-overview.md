# 01 · Architecture Overview

## Purpose
A bird's-eye view of how HR, Payroll, Localization, Self-Service Portal, and the Finance GL fit together. Read this first if you are new to the system.

## The five interlocking modules

```text
                       ┌─────────────────────────────┐
                       │  LOCALIZATION PACKS         │
                       │  (per-country rules, taxes, │
                       │   identifiers, templates)   │
                       └──────────────┬──────────────┘
                                      │ install
                                      ▼
   ┌───────────┐   employee     ┌───────────────┐   payslip_lines    ┌───────────────┐
   │   HR /    ├───────────────►│   PAYROLL     ├────────────────────►   FINANCE/GL  │
   │ EMPLOYEES │   contracts,   │   ENGINE      │   journal entries  │  (accounts,   │
   │           │   identifiers  │ (compute-     │   liabilities      │  journals,    │
   │           │                │  payroll)     │                    │  drift log)   │
   └─────┬─────┘                └───────┬───────┘                    └───────┬───────┘
         │                              │ payslips, certificates              │
         │ user_id                       │                                    │
         ▼                              ▼                                    ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                EMPLOYEE SELF-SERVICE PORTAL  ( /me/* )                   │
   │   payslips · leave · attendance · timesheets · loans · documents         │
   └──────────────────────────────────────────────────────────────────────────┘
```

## Boundary contracts (what each module owns)

| Module | Owns | Reads from others | Writes to others |
|---|---|---|---|
| HR / Employees | `employees`, `employments`, `employee_contracts`, `employee_documents`, `departments`, `job_positions`, `work_locations`, `employee_statutory_identifiers`, `organization_statutory_identifiers` | Localization (`pack_requirements`) | `auth.users` link via invitation flow |
| Attendance / Leave / Timesheets | `attendance*`, `leave_*`, `timesheets*`, `shifts*`, `overtime_requests`, `public_holidays` | `employees`, `attendance_settings` | `payroll_work_entries` (when run starts) |
| Localization Packs | `localization_packs`, `pack_versions`, `pack_requirements`, `pack_token_registry`, `pack_audit_log`, `pack_upgrade_proposals`, `installed_localization_packs`, all `localization_pack_*_templates` | None | `payroll_statutory_rules`, `tax_rates`, `accounts`, `default_account_settings` (on install) |
| Payroll Engine | `payroll_runs`, `payslips`, `payslip_lines`, `payslip_inputs`, `payroll_work_entries`, `payroll_readiness_*`, `payroll_liabilities`, `retro_pay_adjustments`, `payroll_settings`, `salary_structures`, `salary_structure_rule_sets`, `payroll_salary_rules`, `employee_loans`, `loan_*`, `employee_garnishments` | All above | `journal_entries` (via Finance edge fns), `payroll_liabilities` |
| Finance/GL | `accounts`, `journal_entries`, `journal_entry_lines`, `bank_accounts`, `default_account_settings`, `control_account_drift_log` | Payroll posting calls in | None back into HR/Payroll (one-way) |
| Self-Service Portal (`/me/*`) | Nothing of its own | Everything via RLS + `resolve_my_employee()` | `leave_requests`, `attendance` corrections, `timesheets`, `employee_loans` (status='requested'), `performance_goals` |

## Key architectural ADRs

| ADR | Topic | Why it matters here |
|---|---|---|
| **0005** | HR/Payroll split & entitlement architecture | Defines the two-app split and feature gating |
| **0010** | Localization pack versioning & tokens | Versioned snapshots, token registry |
| **0019** | Workspace governance plane | SoD framework that protects payroll/HR actions |
| **0020** | Journal entry narration convention | Forbids UUIDs in JE description/reference |
| **0022** | Payroll mapping integrity | DB trigger blocks invalid GL mappings |
| **0032** | Drift monitoring & JE guard | Daily control-account drift snapshot |
| **0033** | Single AR/AP open-items engine | Pattern reused by `payroll_liabilities` |
| **0034** | Workspace resolution as state, not route | Affects multi-tenant routing for HR/Payroll |
| **0036** | Country-agnostic payroll completion | No hard-coded countries anywhere in engine code |

## Single-source-of-truth tables (memorize these)

- **`payslip_lines`** — every monetary amount paid in any country. *Never* trust legacy typed columns (`paye`, `nhif`, etc. — they are no longer written).
- **`payroll_liabilities`** — single source of truth for statutory amounts owed to authorities.
- **`salary_structure_rule_sets`** — immutable snapshot used by the engine so recompute is byte-identical.
- **`installed_localization_packs`** — what country/pack a tenant is actually running.
- **`employee_statutory_identifiers`** / **`organization_statutory_identifiers`** — the only authoritative place for tax/social IDs.

## Critical edge functions

| Function | When it runs | Owns |
|---|---|---|
| `accept-invitation` | Employee accepts invite | Atomic `user_roles` + `employees.user_id` linkage |
| `install-localization-pack` | Onboarding or pack install | Seeds runtime rule/tax/account rows |
| `publish-localization-pack-version` | Pack publisher | Snapshots pack into immutable `pack_versions` row |
| `compute-payroll` | Payroll run create | Computes payslips from rules + attendance |
| `reverse-payroll` | User reverses a posted run | Calls atomic RPC; negates payslips + JE |
| `post-payroll-gl` | After approval | Writes Dr salary expense / Cr liabilities + net pay JE |
| `post-payroll-payment-gl` | Payment batch | Dr net-pay liability / Cr bank |
| `post-remittance-payment` | Pay statutory authority | Dr liability / Cr bank, allocates against `payroll_liabilities` |
| `post-loan-disbursement` / `post-loan-settlement` | Loan flow | Loan receivable JE |
| `generate-payslip-pdf` / `generate-payroll-document` | UI download | Reads `payslip_lines` |
| `generate-tax-certificate` / `download-tax-certificate` | Year-end | Renders pack templates |
| `generate-statutory-return` | Period filing | CSV/PDF of `payslip_lines` projected per template columns |

## Architecture invariants enforced by tests

Read these tests before changing any of the named files — they will block PRs:

- `src/test/architecture/no-hardcoded-country-payroll.test.ts`
- `src/test/architecture/compute-payroll-uses-rule-set.test.ts`
- `src/test/architecture/payroll-mapping-trigger-guard.test.ts`
- `src/test/architecture/post-payroll-gl-validates-mappings.test.ts`
- `src/test/architecture/je-description-no-uuid.test.ts`
- `src/test/architecture/sod-coverage.test.ts`
- `src/test/architecture/portal-identity-invariants.test.ts`
- `supabase/tests/payslip_immutability_country_agnostic_test.sql`
- `supabase/tests/self_action_guard_test.sql`
- `supabase/tests/employee_pii_masking_test.sql`

## Where the engine "doesn't branch on country"

The platform is country-agnostic. The engine dispatches purely on a `computation_method` value carried inside each rule:

| `computation_method` | Used for |
|---|---|
| `bracket_progressive` | Progressive income tax (e.g., PAYE) |
| `tiered_brackets` | Banded social security with employer + employee shares |
| `percentage_of_gross` | Flat-rate levies on gross |
| `graduated_table` | Look-up table flat amounts per band |
| `flat_amount` | Fixed monthly deduction |
| `per_employee_flat` | Employer-only fixed per active employee (e.g., training levy) |

This is the single most important architectural fact in the system. If you find yourself writing `if (country === 'KE')` you are doing it wrong — codify the rule in a pack instead.
