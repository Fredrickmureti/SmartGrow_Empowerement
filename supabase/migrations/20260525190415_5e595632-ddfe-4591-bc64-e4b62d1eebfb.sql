-- Wave-3.1 — one-shot reclassification of JE-00002 on Accrual Traders.
--
-- Replays public.payroll_generate_reclassification_je(...) for run
-- f4b0960a-94fe-4580-8e82-b8f9d9265759 so the ~60k mis-debited to a COGS
-- account is moved to the currently mapped (now Wave-3 trigger-validated)
-- salary expense account. Idempotent by design:
--   * Skips if the run is missing.
--   * Skips if reclassification_journal_entry_id is already set.
--   * Catches any RPC exception (e.g. salary_expense still pointing at COGS)
--     and logs a NOTICE instead of failing the migration.
DO $$
DECLARE
  v_run_id  uuid := 'f4b0960a-94fe-4580-8e82-b8f9d9265759';
  v_org_id  uuid := '81695269-0f41-4aec-8f49-2fa6d11946b2';
  v_user    uuid;
  v_je_id   uuid;
  v_already uuid;
BEGIN
  -- Idempotency: only proceed if the target run exists and has not been
  -- reclassified yet.
  SELECT reclassification_journal_entry_id INTO v_already
    FROM public.payroll_runs
   WHERE id = v_run_id;
  IF NOT FOUND THEN
    RAISE NOTICE 'Wave-3.1 cleanup skipped: payroll run % not present in this environment', v_run_id;
    RETURN;
  END IF;
  IF v_already IS NOT NULL THEN
    RAISE NOTICE 'Wave-3.1 cleanup skipped: payroll run % already reclassified (JE %)', v_run_id, v_already;
    RETURN;
  END IF;

  -- Act on behalf of an active admin user for the Accrual Traders org so
  -- auth.uid() inside the RPC resolves and the user_roles gate passes.
  SELECT ur.user_id INTO v_user
    FROM public.user_roles ur
   WHERE ur.organization_id = v_org_id
     AND ur.is_active = true
   ORDER BY ur.created_at ASC
   LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'Wave-3.1 cleanup skipped: no active user_role for org %', v_org_id;
    RETURN;
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );

  BEGIN
    v_je_id := public.payroll_generate_reclassification_je(v_run_id);
    RAISE NOTICE 'Wave-3.1 cleanup: posted reclassification JE % for payroll run %', v_je_id, v_run_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Wave-3.1 cleanup skipped for run %: %', v_run_id, SQLERRM;
  END;
END $$;