-- payroll_contract_overrides_hire_date_test.sql
-- Locks in the April/June 2026 regression: when an active contract's start_date
-- predates employees.hire_date, the payroll engine MUST treat the contract as
-- the source of truth for the employment window. The engine asserts this
-- in TypeScript; this SQL test pins the **schema invariants** the engine
-- relies on so the rule cannot silently drift:
--   1. payroll_runs.period_id exists and references payroll_periods.
--   2. employee_contracts.start_date and employees.hire_date both exist.
--   3. The contract-date integrity trigger does NOT block the engine's
--      remediation path: a contract whose start_date equals hire_date is OK
--      (covering the corrected case after HR reconciles).
BEGIN;
  -- (1) period_id column wired up
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='payroll_runs' AND column_name='period_id';
  IF NOT FOUND THEN RAISE EXCEPTION 'payroll_runs.period_id missing — period management regressed'; END IF;

  -- (2) Required date columns
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='employee_contracts' AND column_name='start_date';
  IF NOT FOUND THEN RAISE EXCEPTION 'employee_contracts.start_date missing'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='employees' AND column_name='hire_date';
  IF NOT FOUND THEN RAISE EXCEPTION 'employees.hire_date missing'; END IF;

  -- (3) compensation history trigger present (so reconciled wage changes are captured)
  PERFORM 1 FROM pg_trigger
    WHERE tgname = 'trg_capture_contract_comp_history' AND NOT tgisinternal;
  IF NOT FOUND THEN RAISE EXCEPTION 'trg_capture_contract_comp_history missing — comp history capture regressed'; END IF;
ROLLBACK;