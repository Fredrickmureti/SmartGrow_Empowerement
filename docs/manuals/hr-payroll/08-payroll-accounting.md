# 08 · Payroll Accounting

## Purpose
For each accounting event a payroll generates, this chapter shows the **Dr/Cr** by **account role** (not by country name), the posting edge function, the JE narration, the idempotency key, and the immutability/drift guards.

## Posting architecture

| Layer | Object | Role |
|---|---|---|
| DB trigger | `trg_default_account_settings_payroll_role` | Primary gate (ADR-0022); rejects mapping rows that violate role rules |
| DB function | `_payroll_assert_mapping_role(key, account)` | Called by the trigger |
| DB RPC | `payroll_validate_post_mappings(p_run_id)` | Backstop — called by `post-payroll-gl` immediately before JE write |
| DB RPC | `payroll_apply_proposed_mappings` / `payroll_create_and_map_account` | Only legitimate writers to `default_account_settings` payroll keys |
| Edge fn | `post-payroll-gl` | Orchestrator |
| Hook | `usePayrollGL` | Preflight `validate_payroll_run_mappings` then invoke |

Mapping resolution: org rows first, business-level overrides win when both exist. Keys are lowercase, derived from `payslip_lines.rule_code` at post time (no country literals).

## Event 1 — Gross pay, deductions, net pay (`post-payroll-gl`)

JE narration (ADR-0020): `reference = payroll_runs.payroll_number`; `description = "Payroll <#> - <N> employees"`; `source_type='payroll'`; `source_id=payroll_run_id`.

```text
DR  salary_expense              totalGross           "Payroll <#> - Salary Expense"
CR  <rule_code>_payable         employeeTotal        "Payroll <#> - <label>"   (per deduction)
CR  net_salary_payable          totalNet             "Payroll <#> - Net Pay"

(then, after balance check)
DR  <rule_code>_employer_expense  employerTotal      "Payroll <#> - Employer <label>"
CR  <rule_code>_payable           employerTotal      "Payroll <#> - Employer <label> Payable"
```

- Source: `payslip_lines` only — never legacy typed columns.
- **Idempotency**: `journal_entries` queried for `source_type='payroll'` + `source_id=run_id` + `status≠'voided'`. If found → returns `{ already_posted: true }`.
- **Fiscal period lock**: `fiscal_periods.status='closed'` overlapping period → 409.
- **SoD**: RPC `user_can_post_payroll(_user, _org, _run)` — poster cannot be creator or approver.
- Post-effect: `payroll_runs.status='posted'`, `posted_by/_at` stamped. `payroll_liabilities` upserted (conflict key `(payroll_run_id, rule_code)`).

## Event 2 — Net pay cash disbursement (`post-payroll-payment-gl`)

JE: `reference=batch.batch_number`; `description="Payroll payment <batch#> (run <#>)"`; `source_type='payroll_payment'`; `source_id=batch.id`.

```text
DR  net_salary_payable     batch.total_amount    "Payroll payment <batch#> - clear net pay liability"
CR  bank_accounts.account_id batch.total_amount   "Payroll payment <batch#> - bank disbursement"
```

Idempotency: `payroll_payment_batches.payment_journal_entry_id`. SoD: `user_can_pay_payroll`. Post-effects: `payment_batch_items.status='paid'`; `payslips.status='paid'`; if all run payslips are paid → `payroll_runs.status='paid'`.

## Event 3 — Statutory remittance payment (`post-remittance-payment`)

Called from `RemittanceTracking.tsx`. JE: `reference=ref_number`; `description="Statutory remittance payment - <authority>"`; `source_type='payroll_remittance_payment'`.

```text
DR  liability_account_id   alloc.amount   "Remittance <authority> - <label>"
       (aggregated per liability_account_id when allocs share a GL account)
CR  bank_account_id        total          "Remittance payment <authority> [ref <ref>]"
```

Validation: all `liability_id` same `business_id` + `authority_name`; status not paid/void/legacy_paid; `alloc.amount ≤ outstanding_amount`; bank must be asset/bank/cash; every liability needs `liability_account_id`.

Post-effects: header `payroll_remittance_payments` + `payroll_remittance_payment_allocations` rows. Trigger `trg_recompute_liab_on_alloc` recomputes each liability and flips status to `'paid'` when fully cleared. Single-source liabilities mirror to legacy `payroll_remittances`.

## Event 4 — Loan disbursement (`post-loan-disbursement`)

JE: `description="Loan disbursement — <loan_number>"`; `source_type='loan_disbursement'`; `source_id=loan.id`.

```text
DR  loan_types.gl_receivable_account_id            principal   "Loan receivable — <#>"
CR  loan_types.gl_disbursement_clearing_account_id principal   "Disbursement clearing — <#>"
```

Account source: `loan_types` columns (not `default_account_settings`). Idempotency: `source_type` + `source_id`. **Note**: this function inserts JE rows directly rather than using `post_journal_entry_atomic` (pre-Wave-3 pattern, still in production).

## Event 5 — Loan settlement / write-off (`post-loan-settlement`)

```text
Normal:
  DR  gl_disbursement_clearing_account_id   outstanding_balance   "Settlement clearing — <#>"
  CR  gl_receivable_account_id              outstanding_balance   "Loan receivable — <#>"

Write-off:
  DR  default_account_settings['loan_writeoff_expense'] (fallback 'salary_expense')  amount
  CR  gl_receivable_account_id                                                        amount
```

## Event 6 — Reversal (`reverse-payroll` → `payroll_reverse_run_atomic`)

All work inside one DB transaction:
- Negated sub-ledger run + negated payslips/lines.
- Canonical GL void (negating JE lines, guaranteed balanced).
- Terminal status flip on original run.
- `payroll_reclassification_audit` + audit log.

| RPC hint | HTTP |
|---|---|
| `ALREADY_REVERSED` | 409 |
| `INVALID_STATE` / `IS_REVERSAL` | 409 |
| `MISSING_GL_ENTRY` | 422 |
| `PERIOD_LOCKED` | 409 |
| `NO_PAYSLIPS` | 422 |
| `42501` (permission) | 403 |

## Event 7 — Retro pay
Currently flows inside the normal run as a `category='retro'` line on `payslip_lines`. There is no standalone retro JE yet (audit item M-PAY-6).

## Event 8 — Reclassification (ADR-0022 correction tool)
RPC `payroll_generate_reclassification_je(p_run_id)`. Writes balanced correction lines moving COGS-targeted payroll debits onto the currently mapped salary expense. Audit row in `payroll_reclassification_audit`. A run may be reclassified only once — protected by `payroll_runs.reclassification_journal_entry_id` lock.

## JE numbering & narration

- Number from RPC `get_next_journal_entry_number(_org_id)` (`je_number_sequences`). Fallback `JE-${Date.now()}` only on RPC failure.
- ADR-0020: `_reference` is the source doc's human number, `_description` is `"<Kind> <number> (<qualifier>)"`. UUIDs in either field are **forbidden** — enforced by `src/test/architecture/je-description-no-uuid.test.ts`.

## Drift monitoring (ADR-0032)

- Table `control_account_drift_log` is append-only (`organization_id, account_id, gl_balance, subledger_balance, drift, snapshot_at`).
- Index `(organization_id, snapshot_at DESC)`. RLS: org members SELECT; only `service_role` INSERT.
- Cron `snapshot_control_account_drift_daily` at `0 2 * * *` UTC calls `snapshot_control_account_drift()`; inserts rows where `abs(drift) > 0.005`.
- Escalation: `finance_alert_drift_streaks` tracks consecutive daily drift per account/org; alerts read `snapshot_at > now() - interval '1 day'`.
- Reference incident: `docs/audit/2026-05-25-payroll-drift-incident.md` (Accrual Traders COGS, JE-00002).

## Payslip immutability

Triggers `trg_payslips_immutable_upd` (BEFORE UPDATE) and `trg_payslips_immutable_del` (BEFORE DELETE) → `payslips_immutability_guard()`. Payment batches may stamp the allowlist `{status, paid_at, payment_reference, updated_at}` — nothing else can be edited or deleted post-commit. Companion guards on `payroll_runs` and `payslip_lines`.

Country-agnosticism is enforced by pgTAP test 4 in `supabase/tests/payslip_immutability_country_agnostic_test.sql`: the function body must not contain any of `paye, nhif, shif, nssf_employee, nssf_employer, housing_levy, ahl, nita, sdl, paye_uk, paye_ni, irpf, irpef`.

## Architecture guards (your safety net)

- `post-payroll-gl-validates-mappings.test.ts`
- `payroll-mapping-trigger-guard.test.ts`
- `no-hardcoded-country-payroll.test.ts`
- `payroll-no-default-accounts-reads.test.ts`
- `payroll-completion-guards.test.ts`
- `no-client-write-payroll-remittances.test.ts`
- `je-description-no-uuid.test.ts`
- `supabase/tests/payslip_immutability_country_agnostic_test.sql`
- `supabase/tests/payroll_mapping_trigger_test.sql`

> Full evidence: `./_research/05-payroll-accounting-statutory-documents.md`.
