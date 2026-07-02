-- ============================================================
-- F5: stock_movements.business_id NOT NULL + tighten RLS
-- ============================================================
ALTER TABLE public.stock_movements
  ALTER COLUMN business_id SET NOT NULL;

DROP POLICY IF EXISTS stock_movements_select_v2 ON public.stock_movements;
DROP POLICY IF EXISTS stock_movements_insert_v2 ON public.stock_movements;
DROP POLICY IF EXISTS stock_movements_update_v2 ON public.stock_movements;
DROP POLICY IF EXISTS stock_movements_delete_v2 ON public.stock_movements;

CREATE POLICY stock_movements_select_v2 ON public.stock_movements
  FOR SELECT
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read')
  );

CREATE POLICY stock_movements_insert_v2 ON public.stock_movements
  FOR INSERT
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'create')
  );

CREATE POLICY stock_movements_update_v2 ON public.stock_movements
  FOR UPDATE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'write')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
  );

CREATE POLICY stock_movements_delete_v2 ON public.stock_movements
  FOR DELETE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'delete')
  );

-- ============================================================
-- F4: warehouse_stock — replace org-only policies with business-scoped
-- ============================================================
DROP POLICY IF EXISTS org_warehouse_stock_select ON public.warehouse_stock;
DROP POLICY IF EXISTS org_warehouse_stock_insert ON public.warehouse_stock;
DROP POLICY IF EXISTS org_warehouse_stock_update ON public.warehouse_stock;
DROP POLICY IF EXISTS org_warehouse_stock_delete ON public.warehouse_stock;

CREATE POLICY warehouse_stock_select_v2 ON public.warehouse_stock
  FOR SELECT
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read')
  );

CREATE POLICY warehouse_stock_insert_v2 ON public.warehouse_stock
  FOR INSERT
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'create')
  );

CREATE POLICY warehouse_stock_update_v2 ON public.warehouse_stock
  FOR UPDATE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'write')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
  );

CREATE POLICY warehouse_stock_delete_v2 ON public.warehouse_stock
  FOR DELETE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'delete')
  );

-- ============================================================
-- F4: stock_adjustments — replace org-only policies with business-scoped
-- ============================================================
DROP POLICY IF EXISTS "Users can view stock adjustments in their organizations" ON public.stock_adjustments;
DROP POLICY IF EXISTS "Users can create stock adjustments in their organizations" ON public.stock_adjustments;
DROP POLICY IF EXISTS "Users can update stock adjustments in their organizations" ON public.stock_adjustments;
DROP POLICY IF EXISTS "Users can delete stock adjustments in their organizations" ON public.stock_adjustments;

CREATE POLICY stock_adjustments_select_v2 ON public.stock_adjustments
  FOR SELECT
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read')
  );

CREATE POLICY stock_adjustments_insert_v2 ON public.stock_adjustments
  FOR INSERT
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'create')
  );

CREATE POLICY stock_adjustments_update_v2 ON public.stock_adjustments
  FOR UPDATE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'write')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
  );

CREATE POLICY stock_adjustments_delete_v2 ON public.stock_adjustments
  FOR DELETE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'delete')
  );

-- ============================================================
-- F4: stock_adjustment_items — scope through parent adjustment
-- ============================================================
DROP POLICY IF EXISTS "Users can view stock adjustment items" ON public.stock_adjustment_items;
DROP POLICY IF EXISTS "Users can create stock adjustment items" ON public.stock_adjustment_items;
DROP POLICY IF EXISTS "Users can update stock adjustment items" ON public.stock_adjustment_items;
DROP POLICY IF EXISTS "Users can delete stock adjustment items" ON public.stock_adjustment_items;

CREATE POLICY stock_adjustment_items_select_v2 ON public.stock_adjustment_items
  FOR SELECT
  USING (
    adjustment_id IN (
      SELECT sa.id FROM public.stock_adjustments sa
      WHERE public.user_can_access_business(auth.uid(), sa.business_id)
        AND public.user_has_module_permission(auth.uid(), sa.organization_id, sa.business_id, 'products', 'read')
    )
  );

CREATE POLICY stock_adjustment_items_insert_v2 ON public.stock_adjustment_items
  FOR INSERT
  WITH CHECK (
    adjustment_id IN (
      SELECT sa.id FROM public.stock_adjustments sa
      WHERE public.user_can_access_business(auth.uid(), sa.business_id)
        AND public.user_has_module_permission(auth.uid(), sa.organization_id, sa.business_id, 'products', 'create')
    )
  );

CREATE POLICY stock_adjustment_items_update_v2 ON public.stock_adjustment_items
  FOR UPDATE
  USING (
    adjustment_id IN (
      SELECT sa.id FROM public.stock_adjustments sa
      WHERE public.user_can_access_business(auth.uid(), sa.business_id)
        AND public.user_has_module_permission(auth.uid(), sa.organization_id, sa.business_id, 'products', 'write')
    )
  );

CREATE POLICY stock_adjustment_items_delete_v2 ON public.stock_adjustment_items
  FOR DELETE
  USING (
    adjustment_id IN (
      SELECT sa.id FROM public.stock_adjustments sa
      WHERE public.user_can_access_business(auth.uid(), sa.business_id)
        AND public.user_has_module_permission(auth.uid(), sa.organization_id, sa.business_id, 'products', 'delete')
    )
  );