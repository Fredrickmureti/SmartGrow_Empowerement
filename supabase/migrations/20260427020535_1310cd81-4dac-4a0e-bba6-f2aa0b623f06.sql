CREATE OR REPLACE FUNCTION public.get_effective_company_config(p_business_id uuid, p_branch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  biz RECORD;
  br RECORD;
  result jsonb;
  -- Pulled from branch_setting_overrides (new unified whitelist mechanism).
  ov_logo text;
  ov_invoice_prefix text;
  ov_estimate_prefix text;
  ov_bill_prefix text;
  ov_receipt_prefix text;
  ov_doc_address text;
  ov_contact_email text;
  ov_contact_phone text;
  ov_logo_present boolean := false;
  ov_invoice_present boolean := false;
BEGIN
  SELECT * INTO biz FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_branch_id IS NOT NULL THEN
    SELECT * INTO br FROM public.branches WHERE id = p_branch_id AND business_id = p_business_id;

    -- Pull every whitelisted override in one scan. Keys not in the
    -- whitelist are silently ignored (cannot reach this function).
    SELECT
      MAX(CASE WHEN setting_key = 'document_logo_url'  THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'invoice_prefix'     THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'estimate_prefix'    THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'bill_prefix'        THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'receipt_prefix'     THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'document_address'   THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'contact_email'      THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'contact_phone'      THEN setting_value->>0 END)
    INTO
      ov_logo, ov_invoice_prefix, ov_estimate_prefix, ov_bill_prefix,
      ov_receipt_prefix, ov_doc_address, ov_contact_email, ov_contact_phone
    FROM public.branch_setting_overrides
    WHERE branch_id = p_branch_id;

    ov_logo_present    := ov_logo IS NOT NULL;
    ov_invoice_present := ov_invoice_prefix IS NOT NULL;
  END IF;

  -- Note: setting_value is jsonb, but we extract with ->>0 for scalar
  -- values stored as JSON strings, JSON arrays' first element, or numbers.
  -- For plain JSON strings stored via to_jsonb('foo'), ->>0 returns NULL.
  -- Fall back to setting_value::text trimmed of quotes if needed.
  -- (handled in callers via COALESCE chain.)

  result := jsonb_build_object(
    'business_id', biz.id,
    'branch_id', p_branch_id,
    'logo_url', jsonb_build_object(
      'value', COALESCE(ov_logo, br.logo_url, biz.logo_url),
      'source', CASE
        WHEN ov_logo_present THEN 'branch_override'
        WHEN br.logo_url IS NOT NULL THEN 'branch'
        ELSE 'business'
      END
    ),
    'invoice_prefix', jsonb_build_object(
      'value', COALESCE(
        ov_invoice_prefix,
        COALESCE(biz.invoice_prefix,'') || COALESCE(br.invoice_prefix_suffix,'')
      ),
      'source', CASE
        WHEN ov_invoice_present THEN 'branch_override'
        WHEN br.invoice_prefix_suffix IS NOT NULL THEN 'branch'
        ELSE 'business'
      END
    ),
    'estimate_prefix', jsonb_build_object(
      'value', COALESCE(ov_estimate_prefix, biz.estimate_prefix),
      'source', CASE WHEN ov_estimate_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'bill_prefix', jsonb_build_object(
      'value', COALESCE(ov_bill_prefix, biz.bill_prefix),
      'source', CASE WHEN ov_bill_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'receipt_prefix', jsonb_build_object(
      'value', ov_receipt_prefix,
      'source', CASE WHEN ov_receipt_prefix IS NOT NULL THEN 'branch_override' ELSE NULL END
    ),
    'document_address', jsonb_build_object(
      'value', COALESCE(
        ov_doc_address,
        NULLIF(concat_ws(', ', biz.address, biz.city, biz.country), '')
      ),
      'source', CASE WHEN ov_doc_address IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'contact_email', jsonb_build_object(
      'value', COALESCE(ov_contact_email, biz.email),
      'source', CASE WHEN ov_contact_email IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'contact_phone', jsonb_build_object(
      'value', COALESCE(ov_contact_phone, biz.phone),
      'source', CASE WHEN ov_contact_phone IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'receipt_header', jsonb_build_object(
      'value', COALESCE(br.receipt_header, biz.receipt_settings->>'header'),
      'source', CASE WHEN br.receipt_header IS NOT NULL THEN 'branch' ELSE 'business' END
    ),
    'receipt_footer', jsonb_build_object(
      'value', COALESCE(br.receipt_footer, biz.receipt_settings->>'footer'),
      'source', CASE WHEN br.receipt_footer IS NOT NULL THEN 'branch' ELSE 'business' END
    ),
    'default_warehouse_id', jsonb_build_object(
      'value', br.default_warehouse_id,
      'source', CASE WHEN br.default_warehouse_id IS NOT NULL THEN 'branch' ELSE NULL END
    ),
    -- Company-only fields (NEVER branch-overridable by design).
    'base_currency',     jsonb_build_object('value', biz.base_currency,     'source', 'business'),
    'tax_id',            jsonb_build_object('value', biz.tax_id,            'source', 'business'),
    'fiscal_year_start', jsonb_build_object('value', biz.fiscal_year_start, 'source', 'business'),
    'timezone',          jsonb_build_object('value', biz.timezone,          'source', 'business')
  );
  RETURN result;
END;
$function$;