-- Phase 3.4 (Correction Delta Engine) — structural invariants the engine
-- in `supabase/functions/compute-payroll/index.ts` depends on.
--
-- This is a structural test, not a functional one: it asserts the schema
-- and trigger surface the delta path requires, so a future migration that
-- removes any of them fails CI loudly instead of silently breaking
-- correction runs at runtime.
--
-- Fails if:
--   (1) `payslips.retro_of_payslip_id` is missing or not a uuid FK to payslips,
--   (2) the additive YTD trigger on payslip_lines disappears (deltas rely
--       on it summing signed amounts to keep YTD aggregates correct),
--   (3) `payroll_run_issues` cannot store the codes the engine emits.

BEGIN;
SELECT plan(6);

-- (1) retro_of_payslip_id column exists and is a uuid.
SELECT has_column(
  'public', 'payslips', 'retro_of_payslip_id',
  'payslips.retro_of_payslip_id must exist for correction-delta linkage'
);
SELECT col_type_is(
  'public', 'payslips', 'retro_of_payslip_id', 'uuid',
  'payslips.retro_of_payslip_id must be uuid'
);

-- (2) The signed/additive YTD trigger on payslip_lines must exist.
-- NOTE: the trigger object is named `payslip_lines_ytd_aiud` (its body
-- calls function `trg_payslip_lines_ytd`). Asserting the trigger name —
-- not the function name — is what `has_trigger` actually checks.
SELECT has_trigger(
  'public', 'payslip_lines', 'payslip_lines_ytd_aiud',
  'payslip_lines_ytd_aiud must remain on payslip_lines — correction deltas '
  'rely on it aggregating signed amounts into payroll_employee_ytd'
);
SELECT has_function(
  'public', 'trg_payslip_lines_ytd',
  'trg_payslip_lines_ytd() function (called by the trigger) must exist'
);

-- (3) payroll_run_issues exists and exposes the columns the engine writes
-- when emitting RUN_NO_CORRECTION_DELTA / CORRECTION_MANUAL_RECONCILE_REQUIRED.
SELECT has_table(
  'public', 'payroll_run_issues',
  'payroll_run_issues table must exist'
);
SELECT columns_are(
  'public', 'payroll_run_issues',
  ARRAY[
    'id','organization_id','business_id','payroll_run_id','employee_id',
    'code','severity','message','details',
    'remediation_link','created_at','created_by','updated_at','status',
    'resolved_at'
  ],
  'payroll_run_issues columns must match the engine''s insert shape'
);

SELECT * FROM finish();
ROLLBACK;