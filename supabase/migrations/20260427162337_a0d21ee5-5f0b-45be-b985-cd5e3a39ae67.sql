-- ============================================================
-- Settings Architecture Fixes retry: drop/recreate function whose
-- parameter name must change, then repair resolver + audit triggers.
-- Previous failure: cannot change input parameter p_value in place.
-- ============================================================

CREATE OR REPLACE FUNCTION public.settings_jsonb_to_text(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN jsonb_typeof(p_value) = 'string' THEN p_value #>> '{}'
    WHEN jsonb_typeof(p_value) IN ('number', 'boolean') THEN p_value #>> '{}'
    ELSE p_value::text
  END
$$;

DROP FUNCTION IF EXISTS public.set_branch_setting(uuid, text, jsonb, text);

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

GRANT EXECUTE ON FUNCTION public.set_branch_setting(uuid, text, jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_effective_company_config(
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  biz RECORD;
  br_default_warehouse uuid;
  ov_logo text;
  ov_invoice_prefix text;
  ov_estimate_prefix text;
  ov_bill_prefix text;
  ov_receipt_prefix text;
  ov_doc_address text;
  ov_contact_email text;
  ov_contact_phone text;
  ov_receipt_header text;
  ov_receipt_footer text;
BEGIN
  SELECT * INTO biz FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_branch_id IS NOT NULL THEN
    SELECT default_warehouse_id INTO br_default_warehouse
    FROM public.branches
    WHERE id = p_branch_id AND business_id = p_business_id;

    SELECT
      MAX(CASE WHEN setting_key = 'document_logo_url' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'invoice_prefix' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'estimate_prefix' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'bill_prefix' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'receipt_prefix' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'document_address' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'contact_email' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'contact_phone' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'receipt_header' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'receipt_footer' THEN public.settings_jsonb_to_text(setting_value) END)
    INTO ov_logo, ov_invoice_prefix, ov_estimate_prefix, ov_bill_prefix,
         ov_receipt_prefix, ov_doc_address, ov_contact_email, ov_contact_phone,
         ov_receipt_header, ov_receipt_footer
    FROM public.branch_setting_overrides
    WHERE branch_id = p_branch_id AND business_id = p_business_id;
  END IF;

  RETURN jsonb_build_object(
    'business_id', biz.id,
    'branch_id', p_branch_id,
    'logo_url', jsonb_build_object('value', COALESCE(ov_logo, biz.logo_url), 'source', CASE WHEN ov_logo IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'invoice_prefix', jsonb_build_object('value', COALESCE(ov_invoice_prefix, biz.invoice_prefix), 'source', CASE WHEN ov_invoice_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'estimate_prefix', jsonb_build_object('value', COALESCE(ov_estimate_prefix, biz.estimate_prefix), 'source', CASE WHEN ov_estimate_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'bill_prefix', jsonb_build_object('value', COALESCE(ov_bill_prefix, biz.bill_prefix), 'source', CASE WHEN ov_bill_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'receipt_prefix', jsonb_build_object('value', ov_receipt_prefix, 'source', CASE WHEN ov_receipt_prefix IS NOT NULL THEN 'branch_override' ELSE NULL END),
    'document_address', jsonb_build_object('value', COALESCE(ov_doc_address, NULLIF(concat_ws(', ', biz.address, biz.city, biz.country), '')), 'source', CASE WHEN ov_doc_address IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'contact_email', jsonb_build_object('value', COALESCE(ov_contact_email, biz.email), 'source', CASE WHEN ov_contact_email IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'contact_phone', jsonb_build_object('value', COALESCE(ov_contact_phone, biz.phone), 'source', CASE WHEN ov_contact_phone IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'receipt_header', jsonb_build_object('value', COALESCE(ov_receipt_header, biz.receipt_settings->>'header'), 'source', CASE WHEN ov_receipt_header IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'receipt_footer', jsonb_build_object('value', COALESCE(ov_receipt_footer, biz.receipt_settings->>'footer'), 'source', CASE WHEN ov_receipt_footer IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'default_warehouse_id', jsonb_build_object('value', br_default_warehouse, 'source', CASE WHEN br_default_warehouse IS NOT NULL THEN 'branch' ELSE NULL END),
    'base_currency', jsonb_build_object('value', biz.base_currency, 'source', 'business'),
    'tax_id', jsonb_build_object('value', biz.tax_id, 'source', 'business'),
    'fiscal_year_start', jsonb_build_object('value', biz.fiscal_year_start, 'source', 'business'),
    'timezone', jsonb_build_object('value', biz.timezone, 'source', 'business')
  );
END;
$$;

DROP TRIGGER IF EXISTS audit_businesses_settings ON public.businesses;
CREATE TRIGGER audit_businesses_settings
  AFTER UPDATE ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_settings_change(
    'business',
    'name,legal_name,tax_id,registration_number,address,phone,email,base_currency,fiscal_year_start,timezone,logo_url,invoice_prefix,estimate_prefix,bill_prefix,receipt_settings,default_payment_terms,default_tax_rate_id,email_display_name,email_reply_to'
  );

DROP TRIGGER IF EXISTS audit_branch_setting_overrides ON public.branch_setting_overrides;
CREATE TRIGGER audit_branch_setting_overrides
  AFTER UPDATE ON public.branch_setting_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_settings_change('branch', 'setting_value,reason');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='default_account_settings') THEN
    DROP TRIGGER IF EXISTS audit_default_account_settings ON public.default_account_settings;
    CREATE TRIGGER audit_default_account_settings
      AFTER UPDATE ON public.default_account_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change('accounting', 'setting_key,account_id');
  END IF;
END$$;