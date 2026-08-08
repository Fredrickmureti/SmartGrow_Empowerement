-- Tier-validating account resolver.
-- An account is only acceptable if it is active AND belongs to the company
-- (or is org-shared). Otherwise resolution continues down the ladder.
CREATE OR REPLACE FUNCTION public._account_is_postable(
  p_org_id uuid, p_business_id uuid, p_account_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
     WHERE a.id = p_account_id
       AND a.organization_id = p_org_id
       AND (a.business_id = p_business_id OR a.business_id IS NULL)
       AND COALESCE(a.is_active, true) = true
  )
$$;

REVOKE ALL ON FUNCTION public._account_is_postable(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._account_is_postable(uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_product_gl_account(
  p_org_id uuid, p_business_id uuid, p_product_id uuid, p_purpose text
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_product_col text;
  v_setting_key text;
  v_account_id uuid;
  v_category_id uuid;
  v_candidate uuid;
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

  IF p_product_id IS NOT NULL THEN
    -- Tier 1: product override
    EXECUTE format(
      'SELECT %I, category_id FROM public.products WHERE id = $1', v_product_col
    ) INTO v_candidate, v_category_id USING p_product_id;

    IF v_candidate IS NOT NULL
       AND public._account_is_postable(p_org_id, p_business_id, v_candidate) THEN
      RETURN v_candidate;
    END IF;

    -- Tier 2: category chain, nearest usable ancestor wins. An archived or
    -- cross-company account on a nearer ancestor must not shadow a usable one
    -- further up, so every defining ancestor is tested in depth order.
    IF v_category_id IS NOT NULL THEN
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
      $q$, v_product_col, v_product_col) USING v_category_id
      LOOP
        IF public._account_is_postable(p_org_id, p_business_id, v_candidate) THEN
          RETURN v_candidate;
        END IF;
      END LOOP;
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

  IF v_account_id IS NOT NULL
     AND public._account_is_postable(p_org_id, p_business_id, v_account_id) THEN
    RETURN v_account_id;
  END IF;

  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_product_gl_account(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_product_gl_account(uuid, uuid, uuid, text) TO authenticated, service_role;

-- Per-line delivery COGS/inventory journal lines.
-- Called after complete_delivery_atomic has persisted cost_at_shipment, so the
-- amounts here are the same historical costs the stock movements used.
CREATE OR REPLACE FUNCTION public.resolve_delivery_cogs_lines(
  p_dn_id uuid, p_org_id uuid, p_business_id uuid,
  p_is_return boolean, p_delivery_number text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_fallback_inv uuid;
  v_fallback_cogs uuid;
  v_lines jsonb := '[]'::jsonb;
  v_row record;
BEGIN
  -- Legacy detail-type fallback, used only when the ladder yields nothing.
  SELECT id INTO v_fallback_inv FROM public.accounts
   WHERE organization_id = p_org_id AND business_id = p_business_id
     AND detail_type = 'inventory' AND is_active = true LIMIT 1;
  SELECT id INTO v_fallback_cogs FROM public.accounts
   WHERE organization_id = p_org_id AND business_id = p_business_id
     AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

  FOR v_row IN
    SELECT cogs_acct, inv_acct, SUM(amount) AS amount
      FROM (
        SELECT COALESCE(
                 public.resolve_product_gl_account(p_org_id, p_business_id, dni.product_id, 'cogs'),
                 v_fallback_cogs) AS cogs_acct,
               COALESCE(
                 public.resolve_product_gl_account(p_org_id, p_business_id, dni.product_id, 'inventory'),
                 v_fallback_inv) AS inv_acct,
               ABS(dni.quantity_delivered)
                 * COALESCE(dni.cost_at_shipment, p.cost_price, 0) AS amount
          FROM public.delivery_note_items dni
          LEFT JOIN public.products p ON p.id = dni.product_id
         WHERE dni.delivery_note_id = p_dn_id
           AND dni.quantity_delivered > 0
           AND dni.product_id IS NOT NULL
           AND COALESCE(p.track_inventory, true) = true
      ) s
     WHERE s.amount > 0 AND s.cogs_acct IS NOT NULL AND s.inv_acct IS NOT NULL
     GROUP BY cogs_acct, inv_acct
     ORDER BY cogs_acct, inv_acct
  LOOP
    IF p_is_return THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_row.inv_acct, 'debit', v_row.amount, 'credit', 0,
                           'description', 'Inventory restore - ' || p_delivery_number),
        jsonb_build_object('account_id', v_row.cogs_acct, 'debit', 0, 'credit', v_row.amount,
                           'description', 'COGS reversal - ' || p_delivery_number)
      );
    ELSE
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_row.cogs_acct, 'debit', v_row.amount, 'credit', 0,
                           'description', 'COGS - ' || p_delivery_number),
        jsonb_build_object('account_id', v_row.inv_acct, 'debit', 0, 'credit', v_row.amount,
                           'description', 'Inventory reduction - ' || p_delivery_number)
      );
    END IF;
  END LOOP;

  RETURN v_lines;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_delivery_cogs_lines(uuid, uuid, uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_delivery_cogs_lines(uuid, uuid, uuid, boolean, text) TO authenticated, service_role;