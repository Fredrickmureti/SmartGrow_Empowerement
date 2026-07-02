-- ============================================================
-- Finalize Odoo-grade settings/audit safeguards and document
-- admin-configurable marketplace add-on pricing.
-- ============================================================

-- 1) Make the generic audit trigger safe for INSERT / UPDATE / DELETE.
CREATE OR REPLACE FUNCTION public.audit_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_scope text := COALESCE(TG_ARGV[0], 'unknown');
  v_watched text := COALESCE(TG_ARGV[1], '');
  v_org_id uuid;
  v_business_id uuid;
  v_branch_id uuid;
  v_record_id uuid;
  v_changes_old jsonb := '{}'::jsonb;
  v_changes_new jsonb := '{}'::jsonb;
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_row jsonb := '{}'::jsonb;
  v_col text;
  v_changed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_row := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row := v_new;
  ELSIF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_row := v_old;
  END IF;

  v_org_id := NULLIF(v_row->>'organization_id','')::uuid;
  v_business_id := NULLIF(v_row->>'business_id','')::uuid;
  v_branch_id := NULLIF(v_row->>'branch_id','')::uuid;
  v_record_id := NULLIF(v_row->>'id','')::uuid;

  IF TG_OP = 'INSERT' THEN
    IF v_watched <> '' THEN
      FOR v_col IN SELECT trim(unnest(string_to_array(v_watched, ','))) LOOP
        IF v_new ? v_col THEN
          v_changes_new := v_changes_new || jsonb_build_object(v_col, v_new->v_col);
          v_changed := true;
        END IF;
      END LOOP;
    ELSE
      v_changes_new := v_new;
      v_changed := true;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF v_watched <> '' THEN
      FOR v_col IN SELECT trim(unnest(string_to_array(v_watched, ','))) LOOP
        IF v_old ? v_col THEN
          v_changes_old := v_changes_old || jsonb_build_object(v_col, v_old->v_col);
          v_changed := true;
        END IF;
      END LOOP;
    ELSE
      v_changes_old := v_old;
      v_changed := true;
    END IF;
  ELSE
    IF v_watched <> '' THEN
      FOR v_col IN SELECT trim(unnest(string_to_array(v_watched, ','))) LOOP
        IF (v_old ? v_col) AND (v_new ? v_col)
           AND (v_old->v_col) IS DISTINCT FROM (v_new->v_col) THEN
          v_changes_old := v_changes_old || jsonb_build_object(v_col, v_old->v_col);
          v_changes_new := v_changes_new || jsonb_build_object(v_col, v_new->v_col);
          v_changed := true;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_changed THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_org_id IS NULL AND v_business_id IS NOT NULL THEN
    SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = v_business_id;
  END IF;
  IF v_org_id IS NULL AND v_branch_id IS NOT NULL THEN
    SELECT organization_id INTO v_org_id FROM public.branches WHERE id = v_branch_id;
  END IF;

  IF v_org_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.settings_audit_log (
    organization_id, business_id, branch_id, actor_id,
    setting_scope, setting_key, table_name, record_id,
    old_value, new_value, reason
  ) VALUES (
    v_org_id, v_business_id, v_branch_id, auth.uid(),
    v_scope,
    CASE
      WHEN v_watched <> '' THEN array_to_string(ARRAY(SELECT jsonb_object_keys(COALESCE(NULLIF(v_changes_new, '{}'::jsonb), v_changes_old))), ',')
      ELSE TG_OP
    END,
    TG_TABLE_NAME,
    v_record_id,
    NULLIF(v_changes_old, '{}'::jsonb),
    NULLIF(v_changes_new, '{}'::jsonb),
    COALESCE(v_new->>'reason', v_old->>'reason')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 2) Re-attach generic triggers with INSERT/UPDATE/DELETE coverage where safe.
-- Branch overrides are intentionally excluded from the generic trigger because
-- branch override RPCs write one canonical audit row themselves and require reason.
DROP TRIGGER IF EXISTS audit_branch_setting_overrides ON public.branch_setting_overrides;
DROP TRIGGER IF EXISTS trg_audit_settings_change ON public.branch_setting_overrides;

DROP TRIGGER IF EXISTS audit_businesses_settings ON public.businesses;
CREATE TRIGGER audit_businesses_settings
  AFTER INSERT OR UPDATE OR DELETE ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_settings_change(
    'business',
    'name,legal_name,tax_id,registration_number,address,phone,email,base_currency,fiscal_year_start,timezone,logo_url,invoice_prefix,estimate_prefix,bill_prefix,receipt_settings,default_payment_terms,default_tax_rate_id,email_display_name,email_reply_to'
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='default_account_settings') THEN
    DROP TRIGGER IF EXISTS audit_default_account_settings ON public.default_account_settings;
    CREATE TRIGGER audit_default_account_settings
      AFTER INSERT OR UPDATE OR DELETE ON public.default_account_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change('accounting', 'setting_key,account_id');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tax_rates') THEN
    DROP TRIGGER IF EXISTS audit_tax_rates_settings ON public.tax_rates;
    CREATE TRIGGER audit_tax_rates_settings
      AFTER INSERT OR UPDATE OR DELETE ON public.tax_rates
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change('tax', 'name,rate,is_active,is_default,tax_type');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='payment_provider_configs') THEN
    DROP TRIGGER IF EXISTS audit_payment_provider_configs ON public.payment_provider_configs;
    CREATE TRIGGER audit_payment_provider_configs
      AFTER INSERT OR UPDATE OR DELETE ON public.payment_provider_configs
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change('payments', 'is_active,provider,environment,config');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pos_settings') THEN
    DROP TRIGGER IF EXISTS audit_pos_settings ON public.pos_settings;
    CREATE TRIGGER audit_pos_settings
      AFTER INSERT OR UPDATE OR DELETE ON public.pos_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change('pos', 'receipt_header,receipt_footer,default_tax_rate,allow_discount,require_customer');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='app_pricing_rules') THEN
    DROP TRIGGER IF EXISTS audit_app_pricing_rules ON public.app_pricing_rules;
    CREATE TRIGGER audit_app_pricing_rules
      AFTER INSERT OR UPDATE OR DELETE ON public.app_pricing_rules
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change('platform_billing', 'app_id,monthly_price,yearly_price,currency,is_per_user,is_addon_only,is_active');
  END IF;
END$$;

-- 3) Branch override writes: require reason and write exactly one settings audit row.
CREATE OR REPLACE FUNCTION public.set_branch_setting(
  p_branch_id uuid,
  p_setting_key text,
  p_setting_value jsonb,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_branch RECORD;
  v_existing jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required for branch setting overrides' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.branch_overridable_settings WHERE setting_key = p_setting_key) THEN
    RAISE EXCEPTION 'Setting key % is not branch-overridable', p_setting_key USING ERRCODE = '22023';
  END IF;

  SELECT id, business_id, organization_id INTO v_branch
  FROM public.branches
  WHERE id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Branch % not found', p_branch_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.has_role(v_user, v_branch.organization_id, 'super_admin'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'owner'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only org admins/owners can override branch settings' USING ERRCODE = '42501';
  END IF;

  SELECT setting_value INTO v_existing
  FROM public.branch_setting_overrides
  WHERE branch_id = p_branch_id AND setting_key = p_setting_key;

  INSERT INTO public.branch_setting_overrides
    (branch_id, organization_id, business_id, setting_key, setting_value, set_by, reason)
  VALUES
    (p_branch_id, v_branch.organization_id, v_branch.business_id, p_setting_key, p_setting_value, v_user, p_reason)
  ON CONFLICT (branch_id, setting_key) DO UPDATE SET
    setting_value = EXCLUDED.setting_value,
    set_by = EXCLUDED.set_by,
    reason = EXCLUDED.reason,
    updated_at = now();

  INSERT INTO public.settings_audit_log (
    organization_id, business_id, branch_id, actor_id,
    setting_scope, setting_key, table_name, record_id,
    old_value, new_value, reason
  ) VALUES (
    v_branch.organization_id, v_branch.business_id, p_branch_id, v_user,
    'branch', p_setting_key, 'branch_setting_overrides', p_branch_id,
    jsonb_build_object('setting_value', v_existing),
    jsonb_build_object('setting_value', p_setting_value),
    p_reason
  );

  RETURN jsonb_build_object('success', true, 'branch_id', p_branch_id, 'setting_key', p_setting_key, 'value', p_setting_value);
END;
$$;

DROP FUNCTION IF EXISTS public.clear_branch_setting(uuid, text);
CREATE OR REPLACE FUNCTION public.clear_branch_setting(
  p_branch_id uuid,
  p_setting_key text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_branch RECORD;
  v_old jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Reason is required when clearing branch setting overrides' USING ERRCODE = '22023';
  END IF;

  SELECT id, business_id, organization_id INTO v_branch
  FROM public.branches
  WHERE id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Branch % not found', p_branch_id USING ERRCODE='P0002';
  END IF;

  IF NOT (
    public.has_role(v_user, v_branch.organization_id, 'super_admin'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'owner'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only org admins/owners can clear branch settings' USING ERRCODE='42501';
  END IF;

  DELETE FROM public.branch_setting_overrides
   WHERE branch_id = p_branch_id AND setting_key = p_setting_key
   RETURNING setting_value INTO v_old;

  IF v_old IS NOT NULL THEN
    INSERT INTO public.settings_audit_log (
      organization_id, business_id, branch_id, actor_id,
      setting_scope, setting_key, table_name, record_id,
      old_value, new_value, reason
    ) VALUES (
      v_branch.organization_id, v_branch.business_id, p_branch_id, v_user,
      'branch', p_setting_key, 'branch_setting_overrides', p_branch_id,
      jsonb_build_object('setting_value', v_old),
      jsonb_build_object('setting_value', NULL),
      p_reason
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'branch_id', p_branch_id, 'setting_key', p_setting_key, 'cleared', v_old IS NOT NULL);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_branch_setting(uuid, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_branch_setting(uuid, text, text) TO authenticated;

COMMENT ON TABLE public.app_pricing_rules IS
  'Platform-admin configurable app/add-on pricing. Marketplace labels and billing RPCs must read from this table; app prices must not be hardcoded in client code.';
COMMENT ON COLUMN public.app_pricing_rules.monthly_price IS
  'Monthly add-on price configured by a platform admin, e.g. POS can be changed here instead of in code.';
COMMENT ON COLUMN public.app_pricing_rules.yearly_price IS
  'Yearly add-on price configured by a platform admin, e.g. POS can be changed here instead of in code.';