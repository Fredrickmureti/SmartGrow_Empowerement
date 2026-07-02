# ADR 0022 — Payroll Mapping Integrity (Wave-3)

- **Status:** Accepted (2026-05-25)
- **Supersedes:** Implicit "RPCs are the only writer" assumption.
- **Related:** ADR 0016 (Inventory Adjustment GL Integrity), ADR 0020 (Journal Entry Narration Convention).

## Context

The payroll GL mapping table (`default_account_settings` rows keyed
`salary_expense`, `*_payable`, `*_employer_expense`) drives every payroll
journal entry. Wave-1/2 relied on a single RPC
(`payroll_apply_proposed_mappings`) to enforce role rules — salary cannot
map to a Cost-of-Goods-Sold account, statutory deductions must map to a
liability, no header/parent accounts, etc.

A live incident on **Accrual Traders** (JE-00002, ~60k mis-debited to
account 5100 / COGS) proved the assumption wrong. The Finance →
**Default Accounts** UI was upserting payroll keys directly via
PostgREST. It never went through `payroll_apply_proposed_mappings`, so
the RPC's role guard was completely skipped. The mapping was accepted,
`compute-payroll` resolved `salary_expense` to a COGS account, and
`post-payroll-gl` wrote a balanced but accounting-illegal JE.

## Decision

Mapping role validity is now enforced **at the table tier**, not the RPC
tier. The Wave-3 migration installs:

1. A SECURITY DEFINER helper `_payroll_assert_mapping_role(key, account)`
   that encodes the canonical rules (no COGS for salary or
   `*_employer_expense`; `*_payable` must be liability-typed;
   `salary_expense` / `*_employer_expense` must be expense-typed; no
   header accounts; account must exist).
2. A BEFORE INSERT OR UPDATE trigger
   `trg_default_account_settings_payroll_role` on
   `default_account_settings` that calls the helper for any payroll-shaped
   `setting_key`. Every writer — UI upserts, scripts, future RPCs — is
   subject to the same check.
3. A reclassification flow
   (`payroll_generate_reclassification_je(p_run_id)` +
   `payroll_reclassification_audit` +
   `payroll_runs.reclassification_journal_entry_id`) that posts a balanced
   correction JE moving every COGS-targeted payroll debit to the
   currently mapped (now guard-validated) salary expense account. The new
   JE column is the idempotency lock — a run can only be reclassified
   once.
4. `post-payroll-gl` calls `payroll_validate_post_mappings(run_id)`
   immediately before the JE write as defense-in-depth. The trigger is
   the primary gate; the RPC validator is the backstop for runs whose
   mappings drifted after compute but before post.

## Consequences

- The Finance → Default Accounts UI no longer needs bespoke validation;
  bad writes are rejected with `payroll_mapping_role_violation` regardless
  of where they originate.
- Historical drift is correctable in-product (UI CTA →
  `payroll_generate_reclassification_je`), instead of requiring a manual
  DBA-authored adjusting JE.
- Adding a new payroll setting key requires updating the helper's
  patterns (or extending the trigger's dispatch). The cost is small and
  the failure mode is loud (mapping accepted but never validated → caught
  by `payroll_validate_post_mappings` at post time).
- Other modules (inventory, fixed assets) follow ADR 0016's pattern —
  they will get their own role-check triggers as they need them, not a
  generic `default_account_settings` validator. Each module owns its
  vocabulary.

## Tests

- `src/test/architecture/payroll-mapping-trigger-guard.test.ts` — fails
  if the trigger or its function is dropped, or if a later migration
  weakens it.
- `src/test/architecture/post-payroll-gl-validates-mappings.test.ts` —
  fails if the edge function stops calling `payroll_validate_post_mappings`
  before `post_journal_entry_atomic`, or gates it behind a feature flag.
- `supabase/tests/payroll_mapping_trigger_test.sql` — pgTAP coverage of
  the live trigger (valid + invalid INSERT and UPDATE paths).
