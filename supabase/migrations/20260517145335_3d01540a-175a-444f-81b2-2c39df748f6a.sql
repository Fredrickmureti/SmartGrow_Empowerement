-- ============================================================================
-- Payroll GL mapping writer consolidation
--
-- Root cause of "no unique or exclusion constraint matching the ON CONFLICT
-- specification" on Apply All Suggested:
--   payroll_apply_proposed_mappings / payroll_create_and_map_account use
--     ON CONFLICT (organization_id, business_id, setting_key)
--   but post-Wave-D the only matching FULL unique constraint is
--     default_account_settings_scope_key
--       UNIQUE NULLS NOT DISTINCT (organization_id, business_id, branch_id, setting_key)
--   (the two old partial unique indexes can't be inferred by ON CONFLICT
--    without their WHERE predicate, and they are redundant anyway because
--    NULLS NOT DISTINCT on the 4-col constraint already covers branch IS NULL).
--
-- This migration:
--   1. Drops the two redundant partial unique indexes.
--   2. Adds a single SECURITY DEFINER helper `_upsert_default_account_setting`
--      that uses the canonical named constraint and is the ONLY function any
--      writer (RPC, onboarding seeder, edit-one hook) should call.
--   3. Rewrites payroll_apply_proposed_mappings and
--      payroll_create_and_map_account to:
--        - accept _branch_id (DEFAULT NULL — old callers keep working)
--        - delegate the actual UPSERT to the helper (named constraint)
--        - validate that every account_id being mapped belongs to _org_id
--          AND is visible at the (_business_id, _branch_id) scope
-- ============================================================================

-- 1. Drop redundant partial unique indexes.
DROP INDEX IF EXISTS public.uq_default_account_settings_company;
DROP INDEX IF EXISTS public.uq_default_account_settings_branch;

-- 2. Canonical writer helper. SECURITY DEFINER because the callers are already
--    SECURITY DEFINER and have validated the caller's authority; this is a
--    private mechanical UPSERT and is therefore not granted to any role.
CREATE OR REPLACE FUNCTION public._upsert_default_account_setting(
  _org_id      uuid,
  _business_id uuid,
  _branch_id   uuid,
  _setting_key text,
  _account_id  uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _org_id IS NULL OR _setting_key IS NULL OR _account_id IS NULL THEN
    RAISE EXCEPTION 'org/setting_key/account_id are required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.default_account_settings
    (organization_id, business_id, branch_id, setting_key, account_id)
  VALUES
    (_org_id, _business_id, _branch_id, _setting_key, _account_id)
  ON CONFLICT ON CONSTRAINT default_account_settings_scope_key DO UPDATE
    SET account_id = EXCLUDED.account_id,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public._upsert_default_account_setting(uuid, uuid, uuid, text, uuid) FROM PUBLIC;

-- 3a. payroll_apply_proposed_mappings — branch-aware, named-constraint UPSERT,
--     cross-tenant account_id validation.
CREATE OR REPLACE FUNCTION public.payroll_apply_proposed_mappings(
  _org_id      uuid,
  _business_id uuid,
  _accept      jsonb,
  _branch_id   uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_count      integer := 0;
  item         jsonb;
  v_acct_id    uuid;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user
        AND ur.organization_id = _org_id
        AND ur.is_active = true
    ) THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(_accept, '[]'::jsonb))
  LOOP
    v_acct_id := (item->>'account_id')::uuid;

    -- Cross-tenant guard: account must belong to _org_id and be visible at
    -- the requested business scope (company-shared or this business).
    IF NOT EXISTS (
      SELECT 1
      FROM public.accounts a
      WHERE a.id = v_acct_id
        AND a.organization_id = _org_id
        AND (a.business_id IS NULL OR a.business_id = _business_id)
    ) THEN
      RAISE EXCEPTION 'Account % does not belong to this organization/business', v_acct_id
        USING ERRCODE = '42501';
    END IF;

    PERFORM public._upsert_default_account_setting(
      _org_id, _business_id, _branch_id,
      item->>'setting_key',
      v_acct_id
    );
    v_count := v_count + 1;
  END LOOP;

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_apply_proposed_mappings(uuid, uuid, jsonb, uuid)
  TO authenticated, service_role;

-- 3b. payroll_create_and_map_account — same shape, also branch-aware.
CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id       uuid,
  _business_id  uuid,
  _setting_key  text,
  _name         text,
  _account_type text,
  _code         text DEFAULT NULL,
  _branch_id    uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid;
  v_code       text;
  v_prefix     text;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user
        AND ur.organization_id = _org_id
        AND ur.is_active = true
    ) THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_prefix := CASE lower(_account_type)
    WHEN 'expense'   THEN '6900'
    WHEN 'liability' THEN '2300'
    WHEN 'asset'     THEN '1900'
    WHEN 'income'    THEN '4900'
    WHEN 'equity'    THEN '3900'
    ELSE '9000'
  END;

  v_code := COALESCE(
    _code,
    v_prefix || '-' || upper(left(regexp_replace(_setting_key, '[^a-zA-Z0-9]', '', 'g'), 10))
  );

  IF EXISTS (
    SELECT 1 FROM public.accounts
    WHERE organization_id = _org_id
      AND (business_id IS NULL OR business_id = _business_id)
      AND code = v_code
  ) THEN
    v_code := v_code || '-' || substring(gen_random_uuid()::text, 1, 4);
  END IF;

  INSERT INTO public.accounts (
    organization_id, business_id, code, name, account_type, is_active, is_header
  ) VALUES (
    _org_id, _business_id, v_code, _name, _account_type::public.account_type_enum, true, false
  )
  RETURNING id INTO v_account_id;

  PERFORM public._upsert_default_account_setting(
    _org_id, _business_id, _branch_id, _setting_key, v_account_id
  );

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_create_and_map_account(uuid, uuid, text, text, text, text, uuid)
  TO authenticated, service_role;