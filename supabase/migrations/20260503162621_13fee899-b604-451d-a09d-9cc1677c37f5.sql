
-- =============================================================================
-- Inventory module RLS hardening — branch + business arms on all writes
-- Mirrors purchases hardening (plan 8F42B1C3). All policies use existing
-- helpers: user_can_access_business(uid, business_id),
-- can_access_branch(uid, branch_id), user_has_module_permission(...).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- WAREHOUSES — add branch arm to INSERT/UPDATE/DELETE
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS warehouses_insert_v2 ON public.warehouses;
DROP POLICY IF EXISTS warehouses_update_v2 ON public.warehouses;
DROP POLICY IF EXISTS warehouses_delete_v2 ON public.warehouses;

CREATE POLICY warehouses_insert_v2 ON public.warehouses
  FOR INSERT WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'create'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY warehouses_update_v2 ON public.warehouses
  FOR UPDATE
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'write'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY warehouses_delete_v2 ON public.warehouses
  FOR DELETE USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'delete'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- -----------------------------------------------------------------------------
-- WAREHOUSE_STOCK — branch arm on writes
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS warehouse_stock_insert_v2 ON public.warehouse_stock;
DROP POLICY IF EXISTS warehouse_stock_update_v2 ON public.warehouse_stock;
DROP POLICY IF EXISTS warehouse_stock_delete_v2 ON public.warehouse_stock;

CREATE POLICY warehouse_stock_insert_v2 ON public.warehouse_stock
  FOR INSERT WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY warehouse_stock_update_v2 ON public.warehouse_stock
  FOR UPDATE
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY warehouse_stock_delete_v2 ON public.warehouse_stock
  FOR DELETE USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- -----------------------------------------------------------------------------
-- STOCK_MOVEMENTS — branch arm on writes (SELECT already enforced)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS stock_movements_insert_v2 ON public.stock_movements;
DROP POLICY IF EXISTS stock_movements_update_v2 ON public.stock_movements;
DROP POLICY IF EXISTS stock_movements_delete_v2 ON public.stock_movements;

CREATE POLICY stock_movements_insert_v2 ON public.stock_movements
  FOR INSERT WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'create'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_movements_update_v2 ON public.stock_movements
  FOR UPDATE
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'write'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_movements_delete_v2 ON public.stock_movements
  FOR DELETE USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'delete'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- -----------------------------------------------------------------------------
-- STOCK_ADJUSTMENTS — branch arm on all CRUD
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS stock_adjustments_select_v2 ON public.stock_adjustments;
DROP POLICY IF EXISTS stock_adjustments_insert_v2 ON public.stock_adjustments;
DROP POLICY IF EXISTS stock_adjustments_update_v2 ON public.stock_adjustments;
DROP POLICY IF EXISTS stock_adjustments_delete_v2 ON public.stock_adjustments;

CREATE POLICY stock_adjustments_select_v2 ON public.stock_adjustments
  FOR SELECT USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'read'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_adjustments_insert_v2 ON public.stock_adjustments
  FOR INSERT WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'create'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_adjustments_update_v2 ON public.stock_adjustments
  FOR UPDATE
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'write'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_adjustments_delete_v2 ON public.stock_adjustments
  FOR DELETE USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'delete'::text)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- -----------------------------------------------------------------------------
-- STOCK_TRANSFERS — both from_branch_id and to_branch_id must be accessible
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS stock_transfers_select_v2 ON public.stock_transfers;
DROP POLICY IF EXISTS stock_transfers_insert_v2 ON public.stock_transfers;
DROP POLICY IF EXISTS stock_transfers_update_v2 ON public.stock_transfers;
DROP POLICY IF EXISTS stock_transfers_delete_v2 ON public.stock_transfers;

CREATE POLICY stock_transfers_select_v2 ON public.stock_transfers
  FOR SELECT USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'read'::text)
    AND (
      (from_branch_id IS NULL OR can_access_branch(auth.uid(), from_branch_id))
      OR (to_branch_id IS NULL OR can_access_branch(auth.uid(), to_branch_id))
    )
  );

CREATE POLICY stock_transfers_insert_v2 ON public.stock_transfers
  FOR INSERT WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'create'::text)
    AND (from_branch_id IS NULL OR can_access_branch(auth.uid(), from_branch_id))
    AND (to_branch_id IS NULL OR can_access_branch(auth.uid(), to_branch_id))
  );

CREATE POLICY stock_transfers_update_v2 ON public.stock_transfers
  FOR UPDATE
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'write'::text)
    AND (from_branch_id IS NULL OR can_access_branch(auth.uid(), from_branch_id))
    AND (to_branch_id IS NULL OR can_access_branch(auth.uid(), to_branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (from_branch_id IS NULL OR can_access_branch(auth.uid(), from_branch_id))
    AND (to_branch_id IS NULL OR can_access_branch(auth.uid(), to_branch_id))
  );

CREATE POLICY stock_transfers_delete_v2 ON public.stock_transfers
  FOR DELETE USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'inventory'::text, 'delete'::text)
    AND (from_branch_id IS NULL OR can_access_branch(auth.uid(), from_branch_id))
    AND (to_branch_id IS NULL OR can_access_branch(auth.uid(), to_branch_id))
  );

-- -----------------------------------------------------------------------------
-- STOCK_TRANSFER_ITEMS — inherit through parent stock_transfers + business
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS org_stock_transfer_items_select ON public.stock_transfer_items;
DROP POLICY IF EXISTS org_stock_transfer_items_insert ON public.stock_transfer_items;
DROP POLICY IF EXISTS org_stock_transfer_items_update ON public.stock_transfer_items;
DROP POLICY IF EXISTS org_stock_transfer_items_delete ON public.stock_transfer_items;

CREATE POLICY stock_transfer_items_select_v2 ON public.stock_transfer_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_items.transfer_id
        AND user_can_access_business(auth.uid(), t.business_id)
        AND (
          (t.from_branch_id IS NULL OR can_access_branch(auth.uid(), t.from_branch_id))
          OR (t.to_branch_id IS NULL OR can_access_branch(auth.uid(), t.to_branch_id))
        )
    )
  );

CREATE POLICY stock_transfer_items_insert_v2 ON public.stock_transfer_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_items.transfer_id
        AND user_can_access_business(auth.uid(), t.business_id)
        AND (t.from_branch_id IS NULL OR can_access_branch(auth.uid(), t.from_branch_id))
        AND (t.to_branch_id IS NULL OR can_access_branch(auth.uid(), t.to_branch_id))
    )
  );

CREATE POLICY stock_transfer_items_update_v2 ON public.stock_transfer_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_items.transfer_id
        AND user_can_access_business(auth.uid(), t.business_id)
        AND (t.from_branch_id IS NULL OR can_access_branch(auth.uid(), t.from_branch_id))
        AND (t.to_branch_id IS NULL OR can_access_branch(auth.uid(), t.to_branch_id))
    )
  );

CREATE POLICY stock_transfer_items_delete_v2 ON public.stock_transfer_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.stock_transfers t
      WHERE t.id = stock_transfer_items.transfer_id
        AND user_can_access_business(auth.uid(), t.business_id)
        AND (t.from_branch_id IS NULL OR can_access_branch(auth.uid(), t.from_branch_id))
        AND (t.to_branch_id IS NULL OR can_access_branch(auth.uid(), t.to_branch_id))
    )
  );

-- -----------------------------------------------------------------------------
-- STOCK_RESERVATIONS — replace org-only with business + branch
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "stock_reservations org members read" ON public.stock_reservations;
DROP POLICY IF EXISTS "stock_reservations org members write" ON public.stock_reservations;

CREATE POLICY stock_reservations_select_v2 ON public.stock_reservations
  FOR SELECT USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_reservations_insert_v2 ON public.stock_reservations
  FOR INSERT WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_reservations_update_v2 ON public.stock_reservations
  FOR UPDATE USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY stock_reservations_delete_v2 ON public.stock_reservations
  FOR DELETE USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- -----------------------------------------------------------------------------
-- STOCK_LOTS — replace org-only with business
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "stock_lots org members read" ON public.stock_lots;
DROP POLICY IF EXISTS "stock_lots org members write" ON public.stock_lots;

CREATE POLICY stock_lots_select_v2 ON public.stock_lots
  FOR SELECT USING (user_can_access_business(auth.uid(), business_id));

CREATE POLICY stock_lots_write_v2 ON public.stock_lots
  FOR ALL
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

-- -----------------------------------------------------------------------------
-- WAREHOUSE_STOCK_LOTS — gate via parent warehouse business
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "warehouse_stock_lots org members read" ON public.warehouse_stock_lots;
DROP POLICY IF EXISTS "warehouse_stock_lots org members write" ON public.warehouse_stock_lots;

CREATE POLICY warehouse_stock_lots_select_v2 ON public.warehouse_stock_lots
  FOR SELECT USING (user_can_access_business(auth.uid(), business_id));

CREATE POLICY warehouse_stock_lots_write_v2 ON public.warehouse_stock_lots
  FOR ALL
  USING (user_can_access_business(auth.uid(), business_id))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));

-- -----------------------------------------------------------------------------
-- PRODUCT_REORDER_RULES — add business + branch arm
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can manage reorder rules" ON public.product_reorder_rules;
DROP POLICY IF EXISTS "Users can view their organization reorder rules" ON public.product_reorder_rules;

CREATE POLICY product_reorder_rules_select_v2 ON public.product_reorder_rules
  FOR SELECT USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY product_reorder_rules_insert_v2 ON public.product_reorder_rules
  FOR INSERT WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY product_reorder_rules_update_v2 ON public.product_reorder_rules
  FOR UPDATE USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY product_reorder_rules_delete_v2 ON public.product_reorder_rules
  FOR DELETE USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- -----------------------------------------------------------------------------
-- REPLENISHMENT_LOGS — tighten to business
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS replenishment_logs_select ON public.replenishment_logs;
DROP POLICY IF EXISTS replenishment_logs_insert ON public.replenishment_logs;

CREATE POLICY replenishment_logs_select_v2 ON public.replenishment_logs
  FOR SELECT USING (user_can_access_business(auth.uid(), business_id));

CREATE POLICY replenishment_logs_insert_v2 ON public.replenishment_logs
  FOR INSERT WITH CHECK (user_can_access_business(auth.uid(), business_id));
