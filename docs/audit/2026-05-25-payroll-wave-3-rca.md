# Payroll Wave-3 RCA — Salary expense mis-routed to COGS (JE-00002, Accrual Traders)

**Date:** 2026-05-25
**Status:** Closed (Wave-3 + Wave-3.1)
**Severity:** High — posted JE with ~60k debited to a Cost-of-Goods-Sold
account on a live tenant.

## What happened

`PAY-0001` on **Accrual Traders** posted as `JE-00002` with the entire
gross salary debited to account `5100` (a 5xxx COGS account) instead of
a 6xxx Payroll Expense account. The JE balanced, so it did not trip the
generic posting guards, but every downstream report (P&L cost
classification, gross-margin computation, statutory expense bucket)
inherited the wrong cost line.

## Root cause

1. Wave-1/2 enforced payroll mapping role rules inside
   `payroll_apply_proposed_mappings(...)` (no salary → COGS, etc.).
2. The Finance → **Default Accounts** UI (`DefaultAccountsConfig.tsx`)
   wrote directly to `default_account_settings` via PostgREST, bypassing
   the RPC and therefore the role guard.
3. An admin selected the COGS account from the picker when configuring
   `salary_expense`. The row was accepted.
4. `compute-payroll` resolved `salary_expense` → COGS account; the
   payroll engine produced lines as instructed.
5. `post-payroll-gl` wrote a balanced JE. Wave-1 did not yet defend at
   post time, so nothing caught the violation.

The RPC layer was treated as the only writer of payroll mappings. It
wasn't.

## Fix (Wave-3, shipped earlier)

- **R1 — DB-tier enforcement.** BEFORE INSERT/UPDATE trigger
  `trg_default_account_settings_payroll_role` on
  `default_account_settings` calling `_payroll_assert_mapping_role` for
  every payroll-shaped `setting_key`. Closes the PostgREST bypass.
- **R2 — Reclassification flow.**
  `payroll_generate_reclassification_je(p_run_id)` posts a balanced
  correction JE moving every COGS-targeted payroll debit to the currently
  mapped salary expense account; idempotency locked by
  `payroll_runs.reclassification_journal_entry_id`;
  audit row in `payroll_reclassification_audit`.
- **R3 — Defense in depth at post time.** `post-payroll-gl` calls
  `payroll_validate_post_mappings(run_id)` immediately before the JE
  write, returning HTTP 400 `role_violation` if anything has drifted.
- **R4 — UI surfaces.** `PayrollMappingFindingsPanel` mounted on the GL
  Account Mapping page; "Post to GL" disabled on Run Detail dialogs while
  critical findings exist, with tooltip.

## Wave-3.1 closeout (this doc's scope)

- Architecture guards for the trigger and the post-time validator
  (`src/test/architecture/payroll-mapping-trigger-guard.test.ts`,
  `post-payroll-gl-validates-mappings.test.ts`).
- pgTAP coverage of the live trigger
  (`supabase/tests/payroll_mapping_trigger_test.sql`).
- `PayrollMappingFindingsPanel` mounted inside the Run Detail dialog body
  with the "Post reclassification JE" CTA (not just the disabled post
  button).
- One-shot migration that calls
  `payroll_generate_reclassification_je(...)` for run
  `f4b0960a-94fe-4580-8e82-b8f9d9265759` (Accrual Traders, JE-00002) so
  the books are clean on deploy. Guarded by
  `reclassification_journal_entry_id IS NULL` → re-running the migration
  is a no-op.
- ADR 0022 records the table-tier enforcement decision.

## Verification

- Run `bunx vitest run src/test/architecture/payroll-mapping-trigger-guard.test.ts src/test/architecture/post-payroll-gl-validates-mappings.test.ts` — both green.
- After Wave-3.1 migration applied: `payroll_runs.reclassification_journal_entry_id` is non-null for run `f4b0960a-94fe-4580-8e82-b8f9d9265759`; the new JE balances the 5100 debit and re-debits the currently mapped 6xxx Payroll Expense account.
- Open the run in the UI → `PayrollMappingFindingsPanel` shows clean (no critical findings against the now-compliant mapping); the disabled "Post reclassification" CTA is hidden.

## Follow-ups

- Other modules that also write `default_account_settings` (inventory,
  fixed assets) should adopt the same trigger-tier pattern per ADR 0022
  if they introduce role rules in the future. Each module owns its
  vocabulary — no generic validator.
