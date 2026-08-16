CREATE OR REPLACE FUNCTION public.list_products_with_branch_stock(p_org_id uuid, p_business_id uuid, p_branch_id uuid DEFAULT NULL::uuid, p_include_variant_parents boolean DEFAULT false, p_warehouse_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, organization_id uuid, business_id uuid, type text, name text, description text, sku text, unit_price numeric, cost_price numeric, tax_rate numeric, tax_rate_id uuid, is_active boolean, image_url text, category_id uuid, track_inventory boolean, reorder_level numeric, min_order_quantity numeric, order_quantity_increment numeric, sales_account_id uuid, cogs_account_id uuid, inventory_account_id uuid, purchase_account_id uuid, base_uom_id uuid, base_uom_code text, base_uom_name text, sales_uom_id uuid, sales_uom_code text, sales_uom_name text, packaging jsonb, on_hand numeric, reserved numeric, available numeric, branch_scope_label text, category_name text, tax_rate_name text, etims_tax_code text, is_weighted boolean, plu_code text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch_label text;
  v_ids uuid[];
  v_warehouse_id uuid;
  v_warehouse_name text;
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied for business %', p_business_id USING ERRCODE = '42501';
  END IF;

  IF p_branch_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch_id AND b.business_id = p_business_id) THEN
      RAISE EXCEPTION 'branch % does not belong to business %', p_branch_id, p_business_id USING ERRCODE = '22023';
    END IF;
    SELECT b.name INTO v_branch_label FROM public.branches b WHERE b.id = p_branch_id;
    v_branch_label := COALESCE(v_branch_label, 'Branch');
  ELSE
    v_branch_label := 'All branches';
  END IF;

  IF p_warehouse_id IS NOT NULL THEN
    v_warehouse_id := public.resolve_sales_warehouse(p_org_id, p_business_id, p_branch_id, p_warehouse_id);
    IF v_warehouse_id IS NOT NULL THEN
      SELECT w.name INTO v_warehouse_name FROM public.warehouses w WHERE w.id = v_warehouse_id;
      v_branch_label := COALESCE(v_warehouse_name, 'Warehouse');
    END IF;
  END IF;

  SELECT array_agg(p.id)
    INTO v_ids
    FROM public.products p
   WHERE p.organization_id = p_org_id
     AND p.business_id = p_business_id
     AND p.is_active = true
     AND COALESCE(p.status::text, 'active') = 'active'
     AND (p_include_variant_parents OR NOT COALESCE(p.is_variant_parent, false));

  RETURN QUERY
  WITH stock AS (
    SELECT a.product_id, a.on_hand, a.reserved, a.available
      FROM public.resolve_stock_availability_batch(
             COALESCE(v_ids, ARRAY[]::uuid[]), p_business_id, p_branch_id, v_warehouse_id) a
  ), packs AS (
    SELECT pk.product_id,
           jsonb_agg(
             jsonb_build_object(
               'id', pk.id,
               'name', pk.name,
               'qty_in_base_uom', pk.qty_in_base_uom,
               'is_sales_default', COALESCE(pk.is_sales_default, false),
               'is_shipping_unit', COALESCE(pk.is_shipping_unit, false)
             ) ORDER BY pk.qty_in_base_uom
           ) AS levels
      FROM public.product_packaging pk
     WHERE pk.product_id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
     GROUP BY pk.product_id
  )
  SELECT
    p.id, p.organization_id, p.business_id, p.type::text, p.name::text, p.description::text, p.sku::text,
    p.unit_price, p.cost_price, COALESCE(tr.rate, p.tax_rate), p.tax_rate_id, p.is_active, p.image_url::text, p.category_id,
    p.track_inventory, p.reorder_level, p.min_order_quantity, p.order_quantity_increment,
    p.sales_account_id, p.cogs_account_id, p.inventory_account_id, p.purchase_account_id,
    p.base_uom_id, bu.code::text, bu.name::text,
    p.sales_uom_id, su.code::text, su.name::text,
    COALESCE(pk.levels, '[]'::jsonb),
    COALESCE(s.on_hand, 0)::numeric,
    COALESCE(s.reserved, 0)::numeric,
    COALESCE(s.available, 0)::numeric,
    v_branch_label::text,
    pc.name::text,
    tr.name::text,
    tr.etims_tax_code::text,
    COALESCE(p.is_weighted, false),
    p.plu_code::text
  FROM public.products p
  LEFT JOIN stock s ON s.product_id = p.id
  LEFT JOIN packs pk ON pk.product_id = p.id
  LEFT JOIN public.units_of_measure bu ON bu.id = p.base_uom_id
  LEFT JOIN public.units_of_measure su ON su.id = p.sales_uom_id
  LEFT JOIN public.product_categories pc ON pc.id = p.category_id
  LEFT JOIN public.tax_rates tr ON tr.id = p.tax_rate_id
  WHERE p.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
  ORDER BY p.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_products_with_branch_stock(uuid, uuid, uuid, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_products_with_branch_stock(uuid, uuid, uuid, boolean, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_products_with_branch_stock(uuid, uuid, uuid, boolean, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_products_with_branch_stock(uuid, uuid, uuid, boolean, uuid) TO service_role;