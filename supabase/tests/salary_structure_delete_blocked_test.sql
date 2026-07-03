-- salary_structure_delete_blocked_test.sql
--
-- Guards for public.delete_salary_structure preflight.
--
-- Contract:
--   1. Delete is refused unless the structure is archived AND has zero
--      contracts, zero historical payslips, and zero in-flight runs.
--   2. Confirmation name must match exactly.
--   3. Once all blockers clear, delete succeeds and writes a lifecycle
--      event with event='deleted'.
--
-- Stubs authorization for the transaction so we don't need a real
-- auth.uid() session; ROLLBACK reverts.
BEGIN;
  CREATE OR REPLACE FUNCTION public.user_has_module_permission(
    _user_id uuid, _org uuid, _biz uuid, _module text, _permission text
  ) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE OR REPLACE FUNCTION public.user_has_module_permission(
    _user_id uuid, _org uuid, _module text, _permission text
  ) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

  DO $$
  DECLARE
    v_org uuid;
    v_biz uuid;
    v_structure uuid := gen_random_uuid();
    v_events_before int;
    v_events_after int;
    v_err_ok boolean := false;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business to test against; skipping';
      RETURN;
    END IF;

    INSERT INTO public.salary_structures (id, organization_id, business_id, name, code, is_active)
    VALUES (v_structure, v_org, v_biz, 'PGTAP DELETE TEST', 'PGTAP-DEL', true);

    -- (1a) Delete refused while active (not archived).
    BEGIN
      PERFORM public.delete_salary_structure(v_structure, 'PGTAP DELETE TEST');
      RAISE EXCEPTION 'delete succeeded while structure was still active';
    EXCEPTION WHEN foreign_key_violation THEN
      v_err_ok := true;
    END;
    IF NOT v_err_ok THEN
      RAISE EXCEPTION 'expected foreign_key_violation on active-structure delete';
    END IF;

    -- Archive it.
    PERFORM public.archive_salary_structure(v_structure, 'unit test');

    -- (2) Confirmation name mismatch is rejected.
    v_err_ok := false;
    BEGIN
      PERFORM public.delete_salary_structure(v_structure, 'wrong name');
      RAISE EXCEPTION 'delete succeeded with wrong confirmation';
    EXCEPTION WHEN invalid_parameter_value THEN
      v_err_ok := true;
    END;
    IF NOT v_err_ok THEN
      RAISE EXCEPTION 'expected invalid_parameter_value on name mismatch';
    END IF;

    -- (3) Happy path: archived + correct name + no blockers → deletes.
    SELECT count(*) INTO v_events_before
      FROM public.salary_structure_lifecycle_events
      WHERE structure_id = v_structure AND event = 'deleted';

    PERFORM public.delete_salary_structure(v_structure, 'PGTAP DELETE TEST');

    IF EXISTS (SELECT 1 FROM public.salary_structures WHERE id = v_structure) THEN
      RAISE EXCEPTION 'structure row still present after delete';
    END IF;

    SELECT count(*) INTO v_events_after
      FROM public.salary_structure_lifecycle_events
      WHERE structure_id = v_structure AND event = 'deleted';
    IF v_events_after <> v_events_before + 1 THEN
      RAISE EXCEPTION 'expected exactly one deletion lifecycle event; before=%, after=%',
        v_events_before, v_events_after;
    END IF;

    RAISE NOTICE 'delete_salary_structure pgTAP test OK';
  END $$;
ROLLBACK;
