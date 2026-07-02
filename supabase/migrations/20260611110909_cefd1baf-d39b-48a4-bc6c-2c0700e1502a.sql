
CREATE OR REPLACE FUNCTION public.payroll_finalize_pack_install_v2(
  _org_id uuid,
  _business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  pre_readiness jsonb;
  applied jsonb := '[]'::jsonb;
  created jsonb := '[]'::jsonb;
  failures jsonb := '[]'::jsonb;
  row record;
  v_label text;
  v_acct_id uuid;
BEGIN
  SELECT jsonb_agg(to_jsonb(r))
    INTO pre_readiness
    FROM public.payroll_gl_readiness(_org_id, _business_id) r;

  -- Pass 1: apply deterministic suggestions.
  FOR row IN
    SELECT setting_key, suggested_account_id
      FROM public.payroll_gl_readiness(_org_id, _business_id)
     WHERE is_mapped = false AND suggested_account_id IS NOT NULL
  LOOP
    BEGIN
      PERFORM public._payroll_assert_mapping_role(row.setting_key, row.suggested_account_id);
      PERFORM public._upsert_default_account_setting(
        _org_id, _business_id, NULL, row.setting_key, row.suggested_account_id
      );
      applied := applied || jsonb_build_object(
        'setting_key', row.setting_key,
        'account_id', row.suggested_account_id
      );
    EXCEPTION WHEN OTHERS THEN
      failures := failures || jsonb_build_object(
        'setting_key', row.setting_key,
        'phase', 'apply_suggestion',
        'reason', SQLERRM,
        'sqlstate', SQLSTATE
      );
    END;
  END LOOP;

  -- Pass 2: create-and-map any remaining unmapped key.
  FOR row IN
    SELECT setting_key, label, required_account_type
      FROM public.payroll_gl_readiness(_org_id, _business_id)
     WHERE is_mapped = false
  LOOP
    BEGIN
      v_label := COALESCE(
        NULLIF(row.label, ''),
        initcap(replace(row.setting_key, '_', ' '))
      );
      v_acct_id := public.payroll_create_and_map_account(
        _org_id, _business_id, row.setting_key,
        v_label, lower(row.required_account_type), NULL, NULL
      );
      created := created || jsonb_build_object(
        'setting_key', row.setting_key,
        'account_id', v_acct_id,
        'account_type', row.required_account_type,
        'label', v_label
      );
    EXCEPTION WHEN OTHERS THEN
      failures := failures || jsonb_build_object(
        'setting_key', row.setting_key,
        'phase', 'create_and_map',
        'reason', SQLERRM,
        'sqlstate', SQLSTATE,
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
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_finalize_pack_install_v2(uuid, uuid) TO authenticated, service_role;
