-- Fix duplicate overload of public.upsert_system_account.
-- Migration 20260529113139 accidentally created a SECOND overload (different
-- parameter names/order, last arg boolean→text). PostgreSQL kept both, so any
-- 8-arg positional call (every helper in the codebase) now errors with
-- "function ... is not unique". Drop the accidental overload and rewrite the
-- canonical one to also set the trigger-guard GUC.

-- 1) Drop the accidental overload from migration ...113139.
DROP FUNCTION IF EXISTS public.upsert_system_account(
  uuid, uuid, text, text, text, text, text, text, uuid, text
);

-- 2) Recreate the canonical signature (matches every call site in the repo)
--    and inline the `app.upsert_system_account.in_progress` GUC that
--    enforce_system_account_helper requires.
CREATE OR REPLACE FUNCTION public.upsert_system_account(
  _organization_id uuid,
  _business_id     uuid,
  _system_role     text,
  _account_type    text,
  _detail_type     text,
  _suggested_code  text,
  _suggested_name  text,
  _description     text DEFAULT NULL,
  _parent_id       uuid DEFAULT NULL,
  _is_header       boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id uuid;
  v_adopt_id    uuid;
  v_code        text := _suggested_code;
  v_suffix      int  := 0;
  v_inserted_id uuid;
BEGIN
  -- Tell enforce_system_account_helper that this transaction is inside the
  -- canonical helper so its own INSERT/UPDATE on accounts is allowed. The
  -- GUC is transaction-local (third arg = true) and auto-resets at commit.
  PERFORM set_config('app.upsert_system_account.in_progress', '1', true);

  IF _organization_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'upsert_system_account requires organization_id and business_id'
      USING ERRCODE = '22023';
  END IF;
  IF _system_role IS NULL OR length(btrim(_system_role)) = 0 THEN
    RAISE EXCEPTION 'upsert_system_account requires a non-null system_role'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.system_account_roles WHERE role_key = _system_role) THEN
    RAISE EXCEPTION 'upsert_system_account: unknown system_role "%"', _system_role
      USING ERRCODE = '22023';
  END IF;

  -- 1) Canonical hit: a row already carries this role for this business.
  SELECT id INTO v_existing_id
    FROM public.accounts
   WHERE business_id = _business_id
     AND system_role = _system_role
   LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    PERFORM set_config('app.upsert_system_account.in_progress', '', true);
    RETURN v_existing_id;
  END IF;

  -- 2) Orphan adoption: an unidentified is_system row in this business matches
  --    the requested shape. Stamp the role onto it rather than insert a parallel.
  SELECT id INTO v_adopt_id
    FROM public.accounts
   WHERE business_id = _business_id
     AND coalesce(is_system, false) = true
     AND system_role IS NULL
     AND account_type::text = _account_type
     AND (_detail_type IS NULL OR detail_type::text = _detail_type)
     AND (
           code = _suggested_code
        OR lower(name) = lower(_suggested_name)
        OR (_detail_type IS NOT NULL AND detail_type::text = _detail_type)
     )
   ORDER BY (code = _suggested_code) DESC,
            (lower(name) = lower(_suggested_name)) DESC,
            created_at NULLS LAST, id
   LIMIT 1;

  IF v_adopt_id IS NOT NULL THEN
    UPDATE public.accounts
       SET system_role = _system_role
     WHERE id = v_adopt_id;
    PERFORM set_config('app.upsert_system_account.in_progress', '', true);
    RETURN v_adopt_id;
  END IF;

  -- 3) Allocate a non-colliding code.
  WHILE EXISTS (
    SELECT 1 FROM public.accounts
     WHERE business_id = _business_id AND code = v_code
  ) LOOP
    v_suffix := v_suffix + 1;
    v_code := CASE
                WHEN v_suffix = 1 THEN _suggested_code || '-SYS'
                ELSE _suggested_code || '-SYS-' || v_suffix::text
              END;
    IF v_suffix > 50 THEN
      RAISE EXCEPTION 'upsert_system_account: cannot allocate non-colliding code for role "%"',
        _system_role USING ERRCODE = '23505';
    END IF;
  END LOOP;

  -- 4) Insert.
  INSERT INTO public.accounts (
    organization_id, business_id, account_type, detail_type,
    code, name, description, parent_id,
    is_system, is_header, is_active,
    opening_balance, current_balance, system_role
  ) VALUES (
    _organization_id, _business_id, _account_type::public.account_type, _detail_type,
    v_code, _suggested_name, _description, _parent_id,
    true, coalesce(_is_header, false), true,
    0, 0, _system_role
  )
  ON CONFLICT (business_id, system_role) WHERE system_role IS NOT NULL
    DO UPDATE SET name = public.accounts.name
  RETURNING id INTO v_inserted_id;

  PERFORM set_config('app.upsert_system_account.in_progress', '', true);
  RETURN v_inserted_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_system_account(
  uuid, uuid, text, text, text, text, text, text, uuid, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_system_account(
  uuid, uuid, text, text, text, text, text, text, uuid, boolean
) TO authenticated, service_role;

COMMENT ON FUNCTION public.upsert_system_account(
  uuid, uuid, text, text, text, text, text, text, uuid, boolean
) IS
  'Canonical idempotent provisioner for system accounts. Idempotent on
   (business_id, system_role). Sets app.upsert_system_account.in_progress
   so enforce_system_account_helper allows its own INSERT/UPDATE.';

-- 3) Verify exactly one overload remains.
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_proc WHERE proname = 'upsert_system_account';
  IF v <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 upsert_system_account overload, found %', v;
  END IF;
END$$;