-- salary_structure_rename_test.sql
--
-- Guards for public.rename_salary_structure.
--
-- Contract:
--   1. Rename mutates name/code/description and returns the updated row.
--   2. Rename works even when the structure is "frozen" (has published
--      salary_structure_rule_sets) — metadata is always editable per the
--      enterprise lifecycle spec.
--   3. Each rename writes exactly one 'renamed' lifecycle event with the
--      before/after names captured in payload.
--   4. An empty name is rejected.
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
    v_rule_set uuid := gen_random_uuid();
    v_new_name text;
    v_events int;
    v_err_ok boolean := false;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business to test against; skipping';
      RETURN;
    END IF;

    INSERT INTO public.salary_structures (id, organization_id, business_id, name, code, is_active)
    VALUES (v_structure, v_org, v_biz, 'PGTAP RENAME BEFORE', 'PGTAP-REN', true);

    -- Force the "frozen" state by inserting a published rule-set snapshot.
    -- Column set is minimal; we rely on defaults for optional columns.
    INSERT INTO public.salary_structure_rule_sets
      (id, organization_id, business_id, structure_id, version, status, rule_hash, effective_from, components)
    VALUES
      (v_rule_set, v_org, v_biz, v_structure, 1, 'active',
       encode(gen_random_bytes(16), 'hex'), CURRENT_DATE, '[]'::jsonb);

    -- (1) & (2) Rename while frozen succeeds.
    PERFORM public.rename_salary_structure(
      v_structure, 'PGTAP RENAME AFTER', 'PGTAP-REN2', 'updated by test'
    );

    SELECT name INTO v_new_name FROM public.salary_structures WHERE id = v_structure;
    IF v_new_name <> 'PGTAP RENAME AFTER' THEN
      RAISE EXCEPTION 'rename did not update name (got %)', v_new_name;
    END IF;

    -- (3) Exactly one 'renamed' event, payload captures both names.
    SELECT count(*) INTO v_events
      FROM public.salary_structure_lifecycle_events
      WHERE structure_id = v_structure AND event = 'renamed';
    IF v_events <> 1 THEN
      RAISE EXCEPTION 'expected 1 renamed event, got %', v_events;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.salary_structure_lifecycle_events
      WHERE structure_id = v_structure
        AND event = 'renamed'
        AND payload->>'old_name' = 'PGTAP RENAME BEFORE'
        AND payload->>'new_name' = 'PGTAP RENAME AFTER'
    ) THEN
      RAISE EXCEPTION 'renamed event did not capture old_name/new_name';
    END IF;

    -- (4) Empty name rejected.
    BEGIN
      PERFORM public.rename_salary_structure(v_structure, '   ', NULL, NULL);
      RAISE EXCEPTION 'rename accepted empty name';
    EXCEPTION WHEN invalid_parameter_value THEN
      v_err_ok := true;
    END;
    IF NOT v_err_ok THEN
      RAISE EXCEPTION 'expected invalid_parameter_value on empty name';
    END IF;

    RAISE NOTICE 'rename_salary_structure pgTAP test OK';
  END $$;
ROLLBACK;
