-- Wave 1C.1: Canonical primitive for system-account upsert.
-- Every system-account insertion path will route through this in 1C.2.
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
    RETURN v_existing_id;
  END IF;

  -- 2) Orphan adoption: an unidentified is_system row in this business matches
  --    the requested shape. Stamp the role onto it rather than insert a parallel.
  --    Preference order: exact code match > name match > any matching shape.
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
    RETURN v_adopt_id;
  END IF;

  -- 3) Allocate a non-colliding code (only to dodge user-held codes — the role
  --    uniqueness invariant is enforced separately by the partial unique index).
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

  -- 4) Insert. The partial unique index (business_id, system_role) WHERE
  --    system_role IS NOT NULL guarantees no parallel row can win the race.
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
    DO UPDATE SET name = public.accounts.name  -- no-op; just want RETURNING id
  RETURNING id INTO v_inserted_id;

  RETURN v_inserted_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_system_account(uuid, uuid, text, text, text, text, text, text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_system_account(uuid, uuid, text, text, text, text, text, text, uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.upsert_system_account IS
  'Wave 1C.1: single canonical entry point for provisioning a system account.
   Idempotent on (business_id, system_role). Adopts unidentified is_system
   orphans rather than creating parallel rows. All 8 historical INSERT paths
   into accounts will be routed through this helper in Wave 1C.2.';