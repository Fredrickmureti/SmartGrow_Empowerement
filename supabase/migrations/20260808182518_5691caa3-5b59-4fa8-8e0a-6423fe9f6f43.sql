-- Product -> category tiers only. No company default.
-- Callers that need a different final fallback (e.g. a vendor-level expense
-- account) compose it themselves; resolve_product_gl_account appends the
-- company default so there is exactly one implementation of the chain.
CREATE OR REPLACE FUNCTION public.resolve_product_account_override(
  p_org_id uuid, p_business_id uuid, p_product_id uuid, p_purpose text
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_col text;
  v_category_id uuid;
  v_candidate uuid;
BEGIN
  IF p_purpose NOT IN ('sales_revenue','purchase_expense','cogs','inventory') THEN
    RAISE EXCEPTION 'resolve_product_account_override: unknown purpose %', p_purpose
      USING ERRCODE = '22023';
  END IF;
  IF p_product_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_col := CASE p_purpose
    WHEN 'sales_revenue'    THEN 'sales_account_id'
    WHEN 'purchase_expense' THEN 'purchase_account_id'
    WHEN 'cogs'             THEN 'cogs_account_id'
    WHEN 'inventory'        THEN 'inventory_account_id'
  END;

  -- Tier 1: product
  EXECUTE format('SELECT %I, category_id FROM public.products WHERE id = $1', v_col)
     INTO v_candidate, v_category_id USING p_product_id;

  IF v_candidate IS NOT NULL
     AND public._account_is_postable(p_org_id, p_business_id, v_candidate) THEN
    RETURN v_candidate;
  END IF;

  IF v_category_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Tier 2: nearest usable ancestor category
  FOR v_candidate IN EXECUTE format($q$
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, %I AS acct, 0 AS depth
        FROM public.product_categories WHERE id = $1
      UNION ALL
      SELECT c.id, c.parent_id, c.%I, chain.depth + 1
        FROM public.product_categories c
        JOIN chain ON c.id = chain.parent_id
       WHERE chain.depth < 20
    )
    SELECT acct FROM chain WHERE acct IS NOT NULL ORDER BY depth
  $q$, v_col, v_col) USING v_category_id
  LOOP
    IF public._account_is_postable(p_org_id, p_business_id, v_candidate) THEN
      RETURN v_candidate;
    END IF;
  END LOOP;

  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_product_account_override(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_product_account_override(uuid, uuid, uuid, text) TO authenticated, service_role;

-- Canonical resolver = override tiers + company default.
CREATE OR REPLACE FUNCTION public.resolve_product_gl_account(
  p_org_id uuid, p_business_id uuid, p_product_id uuid, p_purpose text
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_setting_key text;
  v_account_id uuid;
BEGIN
  v_account_id := public.resolve_product_account_override(
    p_org_id, p_business_id, p_product_id, p_purpose);
  IF v_account_id IS NOT NULL THEN
    RETURN v_account_id;
  END IF;

  v_setting_key := CASE p_purpose
    WHEN 'sales_revenue'    THEN 'sales_revenue'
    WHEN 'purchase_expense' THEN 'operating_expenses'
    WHEN 'cogs'             THEN 'cogs'
    WHEN 'inventory'        THEN 'inventory'
  END;

  SELECT account_id INTO v_account_id
    FROM public.default_account_settings
   WHERE organization_id = p_org_id
     AND (business_id = p_business_id OR business_id IS NULL)
     AND setting_key = v_setting_key
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  IF v_account_id IS NOT NULL
     AND public._account_is_postable(p_org_id, p_business_id, v_account_id) THEN
    RETURN v_account_id;
  END IF;

  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_product_gl_account(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_product_gl_account(uuid, uuid, uuid, text) TO authenticated, service_role;

DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'confirm_bill_atomic';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'confirm_bill_atomic not found';
  END IF;

  v_old := $old$      CASE WHEN p.track_inventory IS TRUE THEN COALESCE(p.inventory_account_id, v_default_inv) END,
      p.purchase_account_id, c.default_expense_account_id, v_default_exp$old$;

  v_new := $new$      CASE WHEN p.track_inventory IS TRUE THEN COALESCE(
        public.resolve_product_account_override(
          v_bill.organization_id, v_bill.business_id, bi.product_id, 'inventory'),
        v_default_inv) END,
      public.resolve_product_account_override(
        v_bill.organization_id, v_bill.business_id, bi.product_id, 'purchase_expense'),
      c.default_expense_account_id, v_default_exp$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'confirm_bill_atomic expense resolution block does not match expected source; refusing to patch blindly';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $do$;