CREATE OR REPLACE FUNCTION public.list_products_with_branch_stock(p_org_id uuid, p_business_id uuid, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, organization_id uuid, business_id uuid, type text, name text, description text, sku text, unit_price numeric, cost_price numeric, tax_rate numeric, tax_rate_id uuid, is_active boolean, image_url text, category_id uuid, track_inventory boolean, reorder_level numeric, min_order_quantity numeric, order_quantity_increment numeric, sales_account_id uuid, cogs_account_id uuid, inventory_account_id uuid, purchase_account_id uuid, on_hand numeric, reserved numeric, available numeric, branch_scope_label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch_label text;
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

  RETURN QUERY
  WITH stock AS (
    SELECT
      ws.product_id,
      SUM(ws.quantity)::numeric AS on_hand,
      SUM(COALESCE(ws.reserved_quantity,0))::numeric AS reserved
    FROM public.warehouse_stock ws
    JOIN public.warehouses w ON w.id = ws.warehouse_id
    WHERE ws.organization_id = p_org_id
      AND ws.business_id = p_business_id
      AND (p_branch_id IS NULL OR w.branch_id = p_branch_id)
    GROUP BY ws.product_id
  )
  SELECT
    p.id, p.organization_id, p.business_id, p.type::text, p.name, p.description, p.sku,
    p.unit_price, p.cost_price, p.tax_rate, p.tax_rate_id, p.is_active, p.image_url, p.category_id,
    p.track_inventory, p.reorder_level, p.min_order_quantity, p.order_quantity_increment,
    p.sales_account_id, p.cogs_account_id, p.inventory_account_id, p.purchase_account_id,
    COALESCE(s.on_hand, 0)::numeric AS on_hand,
    COALESCE(s.reserved, 0)::numeric AS reserved,
    (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0))::numeric AS available,
    v_branch_label AS branch_scope_label
  FROM public.products p
  LEFT JOIN stock s ON s.product_id = p.id
  WHERE p.organization_id = p_org_id
    AND p.business_id = p_business_id
    AND p.is_active = true
  ORDER BY p.name;
END;
$function$;