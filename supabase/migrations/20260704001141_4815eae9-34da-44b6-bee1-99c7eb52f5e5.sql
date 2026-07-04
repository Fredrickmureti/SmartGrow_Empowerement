
-- ============================================================================
-- Phase 2 — Payroll GL mapping provenance & revert path
-- ============================================================================

-- 1. Schema: add provenance columns to default_account_settings.
ALTER TABLE public.default_account_settings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS origin_pack_id uuid,
  ADD COLUMN IF NOT EXISTS origin_pack_version text,
  ADD COLUMN IF NOT EXISTS overridden_at timestamptz,
  ADD COLUMN IF NOT EXISTS overridden_by uuid,
  ADD COLUMN IF NOT EXISTS override_reason text;

-- Constrain source to the enumerated vocabulary. Use a table check
-- constraint (not a CHECK on now()) so it is immutable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'default_account_settings_source_chk'
  ) THEN
    ALTER TABLE public.default_account_settings
      ADD CONSTRAINT default_account_settings_source_chk
      CHECK (source IN ('pack_default','pack_upgrade','tenant_override','manual','system_seed'));
  END IF;
END $$;

-- Fast lookup by (org, business, source) for the coverage table / diff.
CREATE INDEX IF NOT EXISTS idx_default_account_settings_org_biz_source
  ON public.default_account_settings (organization_id, business_id, source);

COMMENT ON COLUMN public.default_account_settings.source IS
  'Provenance: pack_default (installer/finalize wrote it), pack_upgrade (pack upgrade re-applied it), tenant_override (accountant edited it), manual (legacy/unknown), system_seed (bootstrap).';
COMMENT ON COLUMN public.default_account_settings.origin_pack_id IS
  'When source=pack_default|pack_upgrade, the localization pack that supplied the value.';
COMMENT ON COLUMN public.default_account_settings.origin_pack_version IS
  'Pack version that supplied the value (for upgrade-diff visibility).';

-- 2. Extend the canonical writer to accept provenance. Old callers still work
--    thanks to defaults; new callers pass the true source.
DROP FUNCTION IF EXISTS public._upsert_default_account_setting(uuid, uuid, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public._upsert_default_account_setting(
  _org_id              uuid,
  _business_id         uuid,
  _branch_id           uuid,
  _setting_key         text,
  _account_id          uuid,
  _source              text    DEFAULT 'manual',
  _origin_pack_id      uuid    DEFAULT NULL,
  _origin_pack_version text    DEFAULT NULL,
  _overridden_by       uuid    DEFAULT NULL,
  _override_reason     text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF _org_id IS NULL OR _setting_key IS NULL OR _account_id IS NULL THEN
    RAISE EXCEPTION 'org/setting_key/account_id are required' USING ERRCODE = '22023';
  END IF;
  IF _source NOT IN ('pack_default','pack_upgrade','tenant_override','manual','system_seed') THEN
    RAISE EXCEPTION 'invalid source: %', _source USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.default_account_settings AS d
    (organization_id, business_id, branch_id, setting_key, account_id,
     source, origin_pack_id, origin_pack_version,
     overridden_at, overridden_by, override_reason)
  VALUES
    (_org_id, _business_id, _branch_id, _setting_key, _account_id,
     _source, _origin_pack_id, _origin_pack_version,
     CASE WHEN _source = 'tenant_override' THEN now() ELSE NULL END,
     _overridden_by, _override_reason)
  ON CONFLICT ON CONSTRAINT default_account_settings_scope_key DO UPDATE
    SET account_id           = EXCLUDED.account_id,
        source               = EXCLUDED.source,
        origin_pack_id       = COALESCE(EXCLUDED.origin_pack_id, d.origin_pack_id),
        origin_pack_version  = COALESCE(EXCLUDED.origin_pack_version, d.origin_pack_version),
        overridden_at        = CASE
                                 WHEN EXCLUDED.source = 'tenant_override' THEN now()
                                 WHEN EXCLUDED.source IN ('pack_default','pack_upgrade')
                                   THEN NULL
                                 ELSE d.overridden_at
                               END,
        overridden_by        = CASE
                                 WHEN EXCLUDED.source = 'tenant_override'
                                   THEN COALESCE(EXCLUDED.overridden_by, auth.uid())
                                 WHEN EXCLUDED.source IN ('pack_default','pack_upgrade')
                                   THEN NULL
                                 ELSE d.overridden_by
                               END,
        override_reason      = CASE
                                 WHEN EXCLUDED.source = 'tenant_override'
                                   THEN EXCLUDED.override_reason
                                 WHEN EXCLUDED.source IN ('pack_default','pack_upgrade')
                                   THEN NULL
                                 ELSE d.override_reason
                               END,
        updated_at           = now();
END;
$$;

REVOKE ALL ON FUNCTION public._upsert_default_account_setting(
  uuid, uuid, uuid, text, uuid, text, uuid, text, uuid, text
) FROM PUBLIC;

-- 3. Rewrite payroll_apply_proposed_mappings to accept _source (defaults to
--    'tenant_override' when a human is calling it via RPC; internal callers
--    can override).
DROP FUNCTION IF EXISTS public.payroll_apply_proposed_mappings(uuid, uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.payroll_apply_proposed_mappings(
  _org_id      uuid,
  _business_id uuid,
  _accept      jsonb,
  _branch_id   uuid   DEFAULT NULL,
  _source      text   DEFAULT 'tenant_override',
  _reason      text   DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user       uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_count      integer := 0;
  item         jsonb;
  v_key        text;
  v_acct_id    uuid;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
    ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(_accept, '[]'::jsonb)) LOOP
    v_key := item->>'setting_key';
    v_acct_id := (item->>'account_id')::uuid;
    IF v_key IS NULL OR v_acct_id IS NULL THEN
      RAISE EXCEPTION 'setting_key and account_id are required' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = v_acct_id AND a.organization_id = _org_id
        AND (a.business_id IS NULL OR a.business_id = _business_id)
    ) THEN
      RAISE EXCEPTION 'Account % does not belong to this organization/business', v_acct_id
        USING ERRCODE = '42501';
    END IF;
    PERFORM public._payroll_assert_mapping_role(v_key, v_acct_id);
    PERFORM public._upsert_default_account_setting(
      _org_id, _business_id, _branch_id, v_key, v_acct_id,
      _source, NULL, NULL, v_user, _reason
    );
    v_count := v_count + 1;
  END LOOP;

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_apply_proposed_mappings(uuid, uuid, jsonb, uuid, text, text)
  TO authenticated, service_role;

-- 4. payroll_create_and_map_account keeps its signature but stamps
--    source='tenant_override' by default (a human just created a new account
--    from the mapping UI).
DROP FUNCTION IF EXISTS public.payroll_create_and_map_account(uuid, uuid, text, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id uuid, _business_id uuid, _setting_key text, _name text,
  _account_type text, _code text DEFAULT NULL, _branch_id uuid DEFAULT NULL,
  _source text DEFAULT 'tenant_override'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid; v_code text; v_prefix text;
  v_lname text := lower(coalesce(_name, ''));
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
    ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  END IF;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND lower(_account_type) <> 'expense' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=expense', _setting_key USING ERRCODE = '22023';
  END IF;
  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND (v_lname ~ '(cost of goods sold|cost of sales|cost of revenue|cogs)') THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot create a COGS-flavoured account (%)', _setting_key, _name USING ERRCODE = '22023';
  END IF;
  IF (_setting_key LIKE '%\_payable' ESCAPE '\')
     AND lower(_account_type) <> 'liability' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=liability', _setting_key USING ERRCODE = '22023';
  END IF;

  v_prefix := CASE lower(_account_type)
    WHEN 'expense' THEN '6900' WHEN 'liability' THEN '2300'
    WHEN 'asset' THEN '1900' WHEN 'income' THEN '4900'
    WHEN 'equity' THEN '3900' ELSE '9000'
  END;
  v_code := COALESCE(_code, v_prefix || '-' || upper(left(regexp_replace(_setting_key, '[^a-zA-Z0-9]', '', 'g'), 10)));
  IF EXISTS (
    SELECT 1 FROM public.accounts
    WHERE organization_id = _org_id
      AND (business_id IS NULL OR business_id = _business_id) AND code = v_code
  ) THEN
    v_code := v_code || '-' || substring(gen_random_uuid()::text, 1, 4);
  END IF;

  INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, is_active, is_header)
  VALUES (_org_id, _business_id, v_code, _name, _account_type::public.account_type_enum, true, false)
  RETURNING id INTO v_account_id;

  PERFORM public._payroll_assert_mapping_role(_setting_key, v_account_id);
  PERFORM public._upsert_default_account_setting(
    _org_id, _business_id, _branch_id, _setting_key, v_account_id,
    _source, NULL, NULL, v_user, NULL
  );
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_create_and_map_account(
  uuid, uuid, text, text, text, text, uuid, text
) TO authenticated, service_role;

-- 5. Rewrite pack-install finalizer to stamp source='pack_default' + version.
CREATE OR REPLACE FUNCTION public.payroll_finalize_pack_install_v2(
  _org_id uuid,
  _business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  pre_readiness jsonb;
  applied jsonb := '[]'::jsonb;
  created jsonb := '[]'::jsonb;
  failures jsonb := '[]'::jsonb;
  row record;
  v_label text;
  v_acct_id uuid;
  v_pack_id uuid;
  v_pack_version text;
BEGIN
  SELECT ilp.pack_id, ilp.pack_version
    INTO v_pack_id, v_pack_version
    FROM public.installed_localization_packs ilp
   WHERE ilp.organization_id = _org_id
     AND ilp.business_id = _business_id
     AND ilp.status = 'active'
   ORDER BY ilp.installed_at DESC
   LIMIT 1;

  SELECT jsonb_agg(to_jsonb(r))
    INTO pre_readiness
    FROM public.payroll_gl_readiness(_org_id, _business_id) r;

  FOR row IN
    SELECT setting_key, suggested_account_id
      FROM public.payroll_gl_readiness(_org_id, _business_id)
     WHERE is_mapped = false AND suggested_account_id IS NOT NULL
  LOOP
    BEGIN
      PERFORM public._payroll_assert_mapping_role(row.setting_key, row.suggested_account_id);
      PERFORM public._upsert_default_account_setting(
        _org_id, _business_id, NULL, row.setting_key, row.suggested_account_id,
        'pack_default', v_pack_id, v_pack_version, NULL, NULL
      );
      applied := applied || jsonb_build_object(
        'setting_key', row.setting_key, 'account_id', row.suggested_account_id
      );
    EXCEPTION WHEN OTHERS THEN
      failures := failures || jsonb_build_object(
        'setting_key', row.setting_key, 'phase', 'apply_suggestion',
        'reason', SQLERRM, 'sqlstate', SQLSTATE
      );
    END;
  END LOOP;

  FOR row IN
    SELECT setting_key, label, required_account_type
      FROM public.payroll_gl_readiness(_org_id, _business_id)
     WHERE is_mapped = false
  LOOP
    BEGIN
      v_label := COALESCE(NULLIF(row.label, ''),
                          initcap(replace(row.setting_key, '_', ' ')));
      v_acct_id := public.payroll_create_and_map_account(
        _org_id, _business_id, row.setting_key,
        v_label, lower(row.required_account_type), NULL, NULL, 'pack_default'
      );
      created := created || jsonb_build_object(
        'setting_key', row.setting_key, 'account_id', v_acct_id,
        'account_type', row.required_account_type, 'label', v_label
      );
    EXCEPTION WHEN OTHERS THEN
      failures := failures || jsonb_build_object(
        'setting_key', row.setting_key, 'phase', 'create_and_map',
        'reason', SQLERRM, 'sqlstate', SQLSTATE,
        'account_type', row.required_account_type,
        'label', COALESCE(row.label, row.setting_key)
      );
    END;
  END LOOP;

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);

  RETURN jsonb_build_object(
    'success', (jsonb_array_length(failures) = 0),
    'pre_readiness', COALESCE(pre_readiness, '[]'::jsonb),
    'applied_mappings', applied,
    'created_accounts', created,
    'failures', failures,
    'post_readiness',
      (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
         FROM public.payroll_gl_readiness(_org_id, _business_id) r)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_finalize_pack_install_v2(uuid, uuid)
  TO authenticated, service_role;

-- 6. Revert a single payroll mapping back to the pack's suggested account.
--    Fails cleanly if there is no suggestion (accountant must pick manually).
CREATE OR REPLACE FUNCTION public.revert_payroll_mapping_to_pack_default(
  _org_id      uuid,
  _business_id uuid,
  _setting_key text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_pack_id uuid;
  v_pack_version text;
  v_suggested uuid;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
    ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  END IF;

  SELECT ilp.pack_id, ilp.pack_version
    INTO v_pack_id, v_pack_version
    FROM public.installed_localization_packs ilp
   WHERE ilp.organization_id = _org_id
     AND ilp.business_id = _business_id
     AND ilp.status = 'active'
   ORDER BY ilp.installed_at DESC
   LIMIT 1;

  SELECT suggested_account_id
    INTO v_suggested
    FROM public.payroll_gl_readiness(_org_id, _business_id)
   WHERE setting_key = _setting_key;

  IF v_suggested IS NULL THEN
    RAISE EXCEPTION 'no_pack_default_available: no suggestion for setting_key %', _setting_key
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._payroll_assert_mapping_role(_setting_key, v_suggested);
  PERFORM public._upsert_default_account_setting(
    _org_id, _business_id, NULL, _setting_key, v_suggested,
    'pack_default', v_pack_id, v_pack_version, NULL, NULL
  );
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);

  RETURN jsonb_build_object(
    'setting_key', _setting_key,
    'account_id', v_suggested,
    'source', 'pack_default',
    'origin_pack_version', v_pack_version
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.revert_payroll_mapping_to_pack_default(uuid, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.revert_payroll_mapping_to_pack_default(uuid, uuid, text) IS
  'Restores a single payroll GL mapping to the currently-active localization pack''s suggested account. Records source=pack_default and clears any override metadata. Fails cleanly when no suggestion exists (accountant must pick manually).';

-- 7. Backfill: any existing rows the installer wrote before Phase 2 land as
--    'manual' by column default; upgrade rows to 'pack_default' when they
--    align with an active pack for that (org, business).
UPDATE public.default_account_settings d
   SET source = 'pack_default',
       origin_pack_id = ilp.pack_id,
       origin_pack_version = ilp.pack_version
  FROM public.installed_localization_packs ilp
 WHERE d.organization_id = ilp.organization_id
   AND d.business_id = ilp.business_id
   AND ilp.status = 'active'
   AND d.source = 'manual'
   AND d.created_at <= ilp.installed_at + interval '5 minutes'
   AND d.created_at >= ilp.installed_at - interval '5 minutes';
