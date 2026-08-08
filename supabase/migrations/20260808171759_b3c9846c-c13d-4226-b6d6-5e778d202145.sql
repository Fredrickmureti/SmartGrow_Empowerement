-- Canonical product GL account resolver (ADR 0122).
-- Ladder: product override -> product category (walking parent_id) -> company default.
CREATE OR REPLACE FUNCTION public.resolve_product_gl_account(
  p_org_id uuid,
  p_business_id uuid,
  p_product_id uuid,
  p_purpose text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_product_col text;
  v_setting_key text;
  v_account_id uuid;
  v_category_id uuid;
BEGIN
  IF p_purpose NOT IN ('sales_revenue','purchase_expense','cogs','inventory') THEN
    RAISE EXCEPTION 'resolve_product_gl_account: unknown purpose %', p_purpose
      USING ERRCODE = '22023';
  END IF;

  v_product_col := CASE p_purpose
    WHEN 'sales_revenue'    THEN 'sales_account_id'
    WHEN 'purchase_expense' THEN 'purchase_account_id'
    WHEN 'cogs'             THEN 'cogs_account_id'
    WHEN 'inventory'        THEN 'inventory_account_id'
  END;

  v_setting_key := CASE p_purpose
    WHEN 'sales_revenue'    THEN 'sales_revenue'
    WHEN 'purchase_expense' THEN 'operating_expenses'
    WHEN 'cogs'             THEN 'cogs'
    WHEN 'inventory'        THEN 'inventory'
  END;

  -- Tier 1: product override
  IF p_product_id IS NOT NULL THEN
    EXECUTE format(
      'SELECT %I, category_id FROM public.products WHERE id = $1', v_product_col
    ) INTO v_account_id, v_category_id USING p_product_id;

    IF v_account_id IS NOT NULL THEN
      RETURN v_account_id;
    END IF;

    -- Tier 2: category chain (nearest ancestor that defines the account)
    IF v_category_id IS NOT NULL THEN
      EXECUTE format($q$
        WITH RECURSIVE chain AS (
          SELECT id, parent_id, %I AS acct, 0 AS depth
            FROM public.product_categories WHERE id = $1
          UNION ALL
          SELECT c.id, c.parent_id, c.%I, chain.depth + 1
            FROM public.product_categories c
            JOIN chain ON c.id = chain.parent_id
           WHERE chain.depth < 20
        )
        SELECT acct FROM chain WHERE acct IS NOT NULL ORDER BY depth LIMIT 1
      $q$, v_product_col, v_product_col) INTO v_account_id USING v_category_id;

      IF v_account_id IS NOT NULL THEN
        RETURN v_account_id;
      END IF;
    END IF;
  END IF;

  -- Tier 3: company default
  SELECT account_id INTO v_account_id
    FROM public.default_account_settings
   WHERE organization_id = p_org_id
     AND (business_id = p_business_id OR business_id IS NULL)
     AND setting_key = v_setting_key
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  RETURN v_account_id;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_product_gl_account(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_gl_account(uuid, uuid, uuid, text) TO authenticated, service_role;

-- Sales seam now delegates per-product revenue resolution to the canonical ladder.
CREATE OR REPLACE FUNCTION public._resolve_invoice_gl_accounts(
  p_org_id uuid, p_business_id uuid, p_contact_id uuid, p_product_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ar_account_id uuid;
  v_ar_default uuid;
  v_revenue_default uuid;
  v_ar_code text;
  v_result jsonb;
  v_revenue_lines jsonb;
BEGIN
  SELECT account_id INTO v_ar_default
    FROM public.default_account_settings
   WHERE organization_id = p_org_id
     AND (business_id = p_business_id OR business_id IS NULL)
     AND setting_key = 'accounts_receivable'
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  SELECT account_id INTO v_revenue_default
    FROM public.default_account_settings
   WHERE organization_id = p_org_id
     AND (business_id = p_business_id OR business_id IS NULL)
     AND setting_key = 'sales_revenue'
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  IF p_contact_id IS NOT NULL THEN
    SELECT default_receivable_account_id INTO v_ar_account_id
      FROM public.contacts WHERE id = p_contact_id;
  END IF;
  v_ar_account_id := COALESCE(v_ar_account_id, v_ar_default);

  SELECT code INTO v_ar_code FROM public.accounts WHERE id = v_ar_account_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', p.id,
           'product_name', p.name,
           'account_id', r.account_id,
           'account_code', (SELECT code FROM public.accounts WHERE id = r.account_id)
         ) ORDER BY p.name), '[]'::jsonb)
    INTO v_revenue_lines
    FROM public.products p
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        public.resolve_product_gl_account(p_org_id, p_business_id, p.id, 'sales_revenue'),
        v_revenue_default
      ) AS account_id
    ) r
   WHERE p.id = ANY(COALESCE(p_product_ids, ARRAY[]::uuid[]));

  v_result := jsonb_build_object(
    'ar_account_id', v_ar_account_id,
    'ar_account_code', v_ar_code,
    'revenue_default_account_id', v_revenue_default,
    'revenue_by_product', v_revenue_lines,
    'resolved_at', now()
  );

  RETURN v_result;
END $function$;