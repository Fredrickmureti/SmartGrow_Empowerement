
-- ============================================================================
-- Stage 2-5: Drop dead mapping tables, migrate org_settings, add branch overrides
-- ============================================================================

-- Stage 3a: Migrate payroll settings from organization_settings → businesses
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS payroll_standard_working_days numeric,
  ADD COLUMN IF NOT EXISTS payroll_standard_hours_per_day numeric,
  ADD COLUMN IF NOT EXISTS payroll_overtime_multiplier numeric;

-- Backfill from organization_settings (one workspace → primary business)
DO $$
DECLARE
  rec RECORD;
  target_business_id uuid;
  num_val numeric;
BEGIN
  -- Only run if table exists and has rows
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='organization_settings') THEN
    FOR rec IN
      SELECT organization_id, setting_key, setting_value
      FROM public.organization_settings
      WHERE setting_key IN ('payroll_standard_working_days','payroll_standard_hours_per_day','payroll_overtime_multiplier')
    LOOP
      SELECT id INTO target_business_id
      FROM public.businesses
      WHERE organization_id = rec.organization_id AND is_active = true
      ORDER BY created_at ASC LIMIT 1;

      IF target_business_id IS NULL THEN CONTINUE; END IF;

      BEGIN
        num_val := (rec.setting_value)::text::numeric;
      EXCEPTION WHEN others THEN
        CONTINUE;
      END;

      IF rec.setting_key = 'payroll_standard_working_days' THEN
        UPDATE public.businesses SET payroll_standard_working_days = num_val WHERE id = target_business_id;
      ELSIF rec.setting_key = 'payroll_standard_hours_per_day' THEN
        UPDATE public.businesses SET payroll_standard_hours_per_day = num_val WHERE id = target_business_id;
      ELSIF rec.setting_key = 'payroll_overtime_multiplier' THEN
        UPDATE public.businesses SET payroll_overtime_multiplier = num_val WHERE id = target_business_id;
      END IF;
    END LOOP;
  END IF;
END $$;

-- Stage 5: Branch override columns (Odoo-style: branches inherit company config)
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS receipt_header text,
  ADD COLUMN IF NOT EXISTS receipt_footer text,
  ADD COLUMN IF NOT EXISTS invoice_prefix_suffix text,
  ADD COLUMN IF NOT EXISTS default_warehouse_id uuid;

COMMENT ON COLUMN public.branches.logo_url IS 'Optional override; falls back to businesses.logo_url';
COMMENT ON COLUMN public.branches.receipt_header IS 'Optional override; falls back to businesses.receipt_settings.header';
COMMENT ON COLUMN public.branches.receipt_footer IS 'Optional override; falls back to businesses.receipt_settings.footer';
COMMENT ON COLUMN public.branches.invoice_prefix_suffix IS 'Appended to businesses.invoice_prefix (e.g. INV-NRB-)';

-- Stage 5b: Effective config resolver for edge functions
CREATE OR REPLACE FUNCTION public.get_effective_company_config(
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  biz RECORD;
  br RECORD;
  result jsonb;
BEGIN
  SELECT * INTO biz FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_branch_id IS NOT NULL THEN
    SELECT * INTO br FROM public.branches WHERE id = p_branch_id AND business_id = p_business_id;
  END IF;

  result := jsonb_build_object(
    'business_id', biz.id,
    'branch_id', p_branch_id,
    'logo_url', jsonb_build_object(
      'value', COALESCE(br.logo_url, biz.logo_url),
      'source', CASE WHEN br.logo_url IS NOT NULL THEN 'branch' ELSE 'business' END
    ),
    'invoice_prefix', jsonb_build_object(
      'value', COALESCE(biz.invoice_prefix,'') || COALESCE(br.invoice_prefix_suffix,''),
      'source', CASE WHEN br.invoice_prefix_suffix IS NOT NULL THEN 'branch' ELSE 'business' END
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
    'base_currency', jsonb_build_object('value', biz.base_currency, 'source', 'business'),
    'tax_id', jsonb_build_object('value', biz.tax_id, 'source', 'business'),
    'fiscal_year_start', jsonb_build_object('value', biz.fiscal_year_start, 'source', 'business'),
    'timezone', jsonb_build_object('value', biz.timezone, 'source', 'business')
  );
  RETURN result;
END;
$$;

-- Stage 2: Drop dead mapping tables (all 0 rows verified)
DROP TABLE IF EXISTS public.default_account_mappings CASCADE;
DROP TABLE IF EXISTS public.pos_gl_mappings CASCADE;
DROP TABLE IF EXISTS public.tax_account_mappings CASCADE;
DROP TABLE IF EXISTS public.payroll_account_mappings CASCADE;
DROP TABLE IF EXISTS public.gl_transaction_mappings CASCADE;

-- Stage 3b: Drop organization_settings (0 rows; payroll keys migrated to businesses)
DROP TABLE IF EXISTS public.organization_settings CASCADE;
