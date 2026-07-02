
-- =====================================================================
-- Settings completion: Phase A (drop duplicate numbering overloads)
-- + Phase B (eliminate dual-writer for branch identity overrides).
-- =====================================================================

-- Phase A — drop legacy overloads.
DROP FUNCTION IF EXISTS public.generate_invoice_number(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_next_bill_number(uuid);
DROP FUNCTION IF EXISTS public.get_next_estimate_number(uuid);
DROP FUNCTION IF EXISTS public.get_next_receipt_number(uuid);

COMMENT ON FUNCTION public.generate_invoice_number(uuid, uuid, uuid)
  IS 'Branch-aware. Resolves prefix through get_effective_company_config and locks per (org, branch). Do NOT add a shorter overload — the legacy 2-arg form ignored branch numbering and could let two branches issue the same invoice number.';
COMMENT ON FUNCTION public.get_next_bill_number(uuid, uuid, uuid)
  IS 'Branch-aware. See generate_invoice_number for the no-overload rule.';
COMMENT ON FUNCTION public.get_next_estimate_number(uuid, uuid, uuid)
  IS 'Branch-aware. See generate_invoice_number for the no-overload rule.';
COMMENT ON FUNCTION public.get_next_receipt_number(uuid, uuid, uuid)
  IS 'Branch-aware. See generate_invoice_number for the no-overload rule.';

-- Phase B.1 — whitelist receipt_header / receipt_footer.
INSERT INTO public.branch_overridable_settings (setting_key, display_name, description, value_type, category)
VALUES
  ('receipt_header', 'Receipt header text', 'Branch-specific text printed at the top of POS / payment receipts. Falls back to the company receipt header when blank.', 'text', 'documents'),
  ('receipt_footer', 'Receipt footer text', 'Branch-specific text printed at the bottom of POS / payment receipts. Falls back to the company receipt footer when blank.', 'text', 'documents')
ON CONFLICT (setting_key) DO NOTHING;

-- Phase B.2 — backfill branches.* identity columns into branch_setting_overrides.
INSERT INTO public.branch_setting_overrides (organization_id, business_id, branch_id, setting_key, setting_value, set_by)
SELECT b.organization_id, b.business_id, b.id, 'document_logo_url', to_jsonb(b.logo_url), NULL
FROM public.branches b
WHERE b.logo_url IS NOT NULL
ON CONFLICT (branch_id, setting_key) DO NOTHING;

INSERT INTO public.branch_setting_overrides (organization_id, business_id, branch_id, setting_key, setting_value, set_by)
SELECT b.organization_id, b.business_id, b.id, 'receipt_header', to_jsonb(b.receipt_header), NULL
FROM public.branches b
WHERE b.receipt_header IS NOT NULL
ON CONFLICT (branch_id, setting_key) DO NOTHING;

INSERT INTO public.branch_setting_overrides (organization_id, business_id, branch_id, setting_key, setting_value, set_by)
SELECT b.organization_id, b.business_id, b.id, 'receipt_footer', to_jsonb(b.receipt_footer), NULL
FROM public.branches b
WHERE b.receipt_footer IS NOT NULL
ON CONFLICT (branch_id, setting_key) DO NOTHING;

-- For invoice_prefix_suffix we materialize the FULL prefix
-- (business prefix + branch suffix) so the JSON store carries the
-- resolved value and the resolver does not need its concatenation rule.
INSERT INTO public.branch_setting_overrides (organization_id, business_id, branch_id, setting_key, setting_value, set_by)
SELECT b.organization_id, b.business_id, b.id, 'invoice_prefix',
       to_jsonb(COALESCE(biz.invoice_prefix, '') || b.invoice_prefix_suffix),
       NULL
FROM public.branches b
JOIN public.businesses biz ON biz.id = b.business_id
WHERE b.invoice_prefix_suffix IS NOT NULL AND b.invoice_prefix_suffix <> ''
ON CONFLICT (branch_id, setting_key) DO NOTHING;

-- Phase B.3 — resolver simplification: single override tier
-- (branch_setting_overrides) → company defaults (businesses.*).
CREATE OR REPLACE FUNCTION public.get_effective_company_config(
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  biz RECORD;
  br_default_warehouse uuid;
  result jsonb;
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
      MAX(CASE WHEN setting_key = 'document_logo_url' THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'invoice_prefix'    THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'estimate_prefix'   THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'bill_prefix'       THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'receipt_prefix'    THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'document_address'  THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'contact_email'     THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'contact_phone'     THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'receipt_header'    THEN setting_value->>0 END),
      MAX(CASE WHEN setting_key = 'receipt_footer'    THEN setting_value->>0 END)
    INTO
      ov_logo, ov_invoice_prefix, ov_estimate_prefix, ov_bill_prefix,
      ov_receipt_prefix, ov_doc_address, ov_contact_email, ov_contact_phone,
      ov_receipt_header, ov_receipt_footer
    FROM public.branch_setting_overrides
    WHERE branch_id = p_branch_id;
  END IF;

  result := jsonb_build_object(
    'business_id', biz.id,
    'branch_id', p_branch_id,
    'logo_url', jsonb_build_object(
      'value',  COALESCE(ov_logo, biz.logo_url),
      'source', CASE WHEN ov_logo IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'invoice_prefix', jsonb_build_object(
      'value',  COALESCE(ov_invoice_prefix, biz.invoice_prefix),
      'source', CASE WHEN ov_invoice_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'estimate_prefix', jsonb_build_object(
      'value',  COALESCE(ov_estimate_prefix, biz.estimate_prefix),
      'source', CASE WHEN ov_estimate_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'bill_prefix', jsonb_build_object(
      'value',  COALESCE(ov_bill_prefix, biz.bill_prefix),
      'source', CASE WHEN ov_bill_prefix IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'receipt_prefix', jsonb_build_object(
      'value',  ov_receipt_prefix,
      'source', CASE WHEN ov_receipt_prefix IS NOT NULL THEN 'branch_override' ELSE NULL END
    ),
    'document_address', jsonb_build_object(
      'value',  COALESCE(ov_doc_address, NULLIF(concat_ws(', ', biz.address, biz.city, biz.country), '')),
      'source', CASE WHEN ov_doc_address IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'contact_email', jsonb_build_object(
      'value',  COALESCE(ov_contact_email, biz.email),
      'source', CASE WHEN ov_contact_email IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'contact_phone', jsonb_build_object(
      'value',  COALESCE(ov_contact_phone, biz.phone),
      'source', CASE WHEN ov_contact_phone IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'receipt_header', jsonb_build_object(
      'value',  COALESCE(ov_receipt_header, biz.receipt_settings->>'header'),
      'source', CASE WHEN ov_receipt_header IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'receipt_footer', jsonb_build_object(
      'value',  COALESCE(ov_receipt_footer, biz.receipt_settings->>'footer'),
      'source', CASE WHEN ov_receipt_footer IS NOT NULL THEN 'branch_override' ELSE 'business' END
    ),
    'default_warehouse_id', jsonb_build_object(
      'value',  br_default_warehouse,
      'source', CASE WHEN br_default_warehouse IS NOT NULL THEN 'branch' ELSE NULL END
    ),
    'base_currency',     jsonb_build_object('value', biz.base_currency,     'source', 'business'),
    'tax_id',            jsonb_build_object('value', biz.tax_id,            'source', 'business'),
    'fiscal_year_start', jsonb_build_object('value', biz.fiscal_year_start, 'source', 'business'),
    'timezone',          jsonb_build_object('value', biz.timezone,          'source', 'business')
  );
  RETURN result;
END;
$function$;

-- Phase B.4 — deprecate the old branches.* identity columns.
COMMENT ON COLUMN public.branches.logo_url IS
  'DEPRECATED — read from branch_setting_overrides via get_effective_company_config. Will be dropped after one release. Do not write here.';
COMMENT ON COLUMN public.branches.receipt_header IS
  'DEPRECATED — read from branch_setting_overrides (key: receipt_header) via get_effective_company_config. Will be dropped after one release. Do not write here.';
COMMENT ON COLUMN public.branches.receipt_footer IS
  'DEPRECATED — read from branch_setting_overrides (key: receipt_footer) via get_effective_company_config. Will be dropped after one release. Do not write here.';
COMMENT ON COLUMN public.branches.invoice_prefix_suffix IS
  'DEPRECATED — read from branch_setting_overrides (key: invoice_prefix, materialized full value) via get_effective_company_config. Will be dropped after one release. Do not write here.';
