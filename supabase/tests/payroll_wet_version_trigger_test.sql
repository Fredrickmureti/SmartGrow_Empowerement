-- payroll_wet_version_trigger_test.sql
-- Pins the optimistic-locking contract the WorkEntryTypes UI relies on:
--   (1) Trigger + function objects exist.
--   (2) A fresh insert starts at version = 1.
--   (3) An UPDATE that touches a payroll-relevant column bumps version.
--   (4) An UPDATE that changes nothing meaningful does NOT bump version
--       (guards `updated_at`-only touches from breaking client locks).
--   (5) UPDATE ... WHERE version = <stale> affects zero rows after a bump
--       (this is the exact contract the client uses to detect concurrent edits).
BEGIN;

  -- (1) Objects present.
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'bump_payroll_wet_version'
    ) THEN
      RAISE EXCEPTION 'bump_payroll_wet_version() is missing';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = 'trg_bump_payroll_wet_version'
         AND NOT tgisinternal
    ) THEN
      RAISE EXCEPTION 'trg_bump_payroll_wet_version trigger is missing';
    END IF;
  END $$;

  -- (2)-(5) Behavioural checks against a scratch row.
  DO $$
  DECLARE
    v_org uuid := gen_random_uuid();
    v_biz uuid := gen_random_uuid();
    v_id  uuid;
    v_v   integer;
    v_rows int;
  BEGIN
    INSERT INTO public.payroll_work_entry_types
      (organization_id, business_id, code, name, is_paid, counts_as_worked,
       multiplier_normal, multiplier_overtime, sequence, is_pack_default, is_active)
    VALUES (v_org, v_biz, 'OT', 'Overtime', true, true, 1, 1.5, 20, false, true)
    RETURNING id, version INTO v_id, v_v;

    IF v_v <> 1 THEN
      RAISE EXCEPTION 'fresh insert should start at version = 1, got %', v_v;
    END IF;

    -- (3) Payroll-relevant UPDATE -> bump.
    UPDATE public.payroll_work_entry_types
       SET multiplier_overtime = 2.0
     WHERE id = v_id;
    SELECT version INTO v_v FROM public.payroll_work_entry_types WHERE id = v_id;
    IF v_v <> 2 THEN
      RAISE EXCEPTION 'meaningful UPDATE should bump version to 2, got %', v_v;
    END IF;

    -- (4) No-op UPDATE (write same values back) -> version unchanged.
    UPDATE public.payroll_work_entry_types
       SET multiplier_overtime = 2.0,
           name = 'Overtime'
     WHERE id = v_id;
    SELECT version INTO v_v FROM public.payroll_work_entry_types WHERE id = v_id;
    IF v_v <> 2 THEN
      RAISE EXCEPTION 'no-op UPDATE must not bump version; got %', v_v;
    END IF;

    -- (5) Stale-version UPDATE affects zero rows — this is the exact
    --     optimistic-locking predicate used by the client.
    UPDATE public.payroll_work_entry_types
       SET name = 'Should not stick'
     WHERE id = v_id
       AND version = 1;   -- stale; current is 2
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'stale-version UPDATE must affect 0 rows; got %', v_rows;
    END IF;

    -- And confirm the row was NOT modified.
    IF EXISTS (SELECT 1 FROM public.payroll_work_entry_types
                WHERE id = v_id AND name = 'Should not stick') THEN
      RAISE EXCEPTION 'stale-version UPDATE somehow mutated the row';
    END IF;
  END $$;

ROLLBACK;
