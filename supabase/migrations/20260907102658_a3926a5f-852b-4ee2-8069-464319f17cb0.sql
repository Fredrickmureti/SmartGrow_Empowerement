CREATE OR REPLACE FUNCTION public.get_effective_company_config(p_business_id uuid, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  biz RECORD;
  ov_logo text;
  ov_doc_address text;
  ov_contact_email text;
  ov_contact_phone text;
  ov_receipt_header text;
  ov_receipt_footer text;
BEGIN
  SELECT * INTO biz FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_branch_id IS NOT NULL THEN
    SELECT
      MAX(CASE WHEN setting_key = 'document_logo_url' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'document_address' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'contact_email' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'contact_phone' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'receipt_header' THEN public.settings_jsonb_to_text(setting_value) END),
      MAX(CASE WHEN setting_key = 'receipt_footer' THEN public.settings_jsonb_to_text(setting_value) END)
    INTO ov_logo, ov_doc_address, ov_contact_email, ov_contact_phone,
         ov_receipt_header, ov_receipt_footer
    FROM public.branch_setting_overrides
    WHERE branch_id = p_branch_id AND business_id = p_business_id;
  END IF;

  RETURN jsonb_build_object(
    'business_id', biz.id,
    'branch_id', p_branch_id,
    'logo_url', jsonb_build_object('value', COALESCE(ov_logo, biz.logo_url), 'source', CASE WHEN ov_logo IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'document_address', jsonb_build_object('value', COALESCE(ov_doc_address, NULLIF(concat_ws(', ', biz.address, biz.city, biz.country), '')), 'source', CASE WHEN ov_doc_address IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'contact_email', jsonb_build_object('value', COALESCE(ov_contact_email, biz.email), 'source', CASE WHEN ov_contact_email IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'contact_phone', jsonb_build_object('value', COALESCE(ov_contact_phone, biz.phone), 'source', CASE WHEN ov_contact_phone IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'receipt_header', jsonb_build_object('value', COALESCE(ov_receipt_header, biz.receipt_settings->>'header'), 'source', CASE WHEN ov_receipt_header IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'receipt_footer', jsonb_build_object('value', COALESCE(ov_receipt_footer, biz.receipt_settings->>'footer'), 'source', CASE WHEN ov_receipt_footer IS NOT NULL THEN 'branch_override' ELSE 'business' END),
    'base_currency', jsonb_build_object('value', biz.base_currency, 'source', 'business'),
    'tax_id', jsonb_build_object('value', biz.tax_id, 'source', 'business'),
    'fiscal_year_start', jsonb_build_object('value', biz.fiscal_year_start, 'source', 'business'),
    'timezone', jsonb_build_object('value', biz.timezone, 'source', 'business')
  );
END;
$function$;