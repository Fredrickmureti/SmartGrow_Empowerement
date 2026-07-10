
-- 1. adjustment_type column ---------------------------------------------------
ALTER TABLE public.stock_adjustments
  ADD COLUMN IF NOT EXISTS adjustment_type text NOT NULL DEFAULT 'stock_take';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_adjustments_adjustment_type_check'
  ) THEN
    ALTER TABLE public.stock_adjustments
      ADD CONSTRAINT stock_adjustments_adjustment_type_check
      CHECK (adjustment_type IN (
        'stock_take','physical_count','scrap','revaluation','opening_balance','other'
      ));
  END IF;
END$$;

UPDATE public.stock_adjustments
   SET adjustment_type = 'scrap'
 WHERE adjustment_type = 'stock_take'
   AND lower(coalesce(reason,'')) IN (
     'damage','damaged','write_off','write-off','writeoff',
     'expired','defective','obsolete','quality_reject','quality',
     'theft','shrinkage','scrap','waste',
     'scrap_damaged','scrap_expired','scrap_defective','scrap_obsolete',
     'scrap_quality','scrap_theft','scrap_other'
   );

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_adjustment_type
  ON public.stock_adjustments(organization_id, business_id, adjustment_type);

-- 2. Extend offset-account resolver to know scrap flavours -------------------
CREATE OR REPLACE FUNCTION public.resolve_adjustment_offset_account(
  p_org_id uuid, p_business_id uuid, p_reason text, p_sign integer
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shrink uuid;
  v_over   uuid;
  v_reval  uuid;
  v_legacy uuid;
  v_obe    uuid;
  v_reason text := lower(coalesce(p_reason,''));
BEGIN
  SELECT shrinkage_account_id, overage_account_id, revaluation_account_id
    INTO v_shrink, v_over, v_reval
    FROM public.ensure_inventory_reason_gl_accounts(p_org_id, p_business_id);

  SELECT adjustment_account_id INTO v_legacy
    FROM public.ensure_inventory_gl_accounts(p_org_id, p_business_id);

  IF v_reason = 'opening_balance' THEN
    v_obe := public.ensure_opening_balance_equity_account(p_org_id, p_business_id);
  END IF;

  RETURN CASE v_reason
    WHEN 'shrinkage'       THEN v_shrink
    WHEN 'damage'          THEN v_shrink
    WHEN 'damaged'         THEN v_shrink
    WHEN 'write_off'       THEN v_shrink
    WHEN 'found_stock'     THEN v_over
    WHEN 'revaluation'     THEN v_reval
    WHEN 'count_variance'  THEN CASE WHEN p_sign >= 0 THEN v_over ELSE v_shrink END
    WHEN 'opening_balance' THEN v_obe
    WHEN 'scrap'            THEN v_shrink
    WHEN 'scrap_damaged'    THEN v_shrink
    WHEN 'scrap_expired'    THEN v_shrink
    WHEN 'scrap_defective'  THEN v_shrink
    WHEN 'scrap_obsolete'   THEN v_shrink
    WHEN 'scrap_quality'    THEN v_shrink
    WHEN 'scrap_theft'      THEN v_shrink
    WHEN 'scrap_other'      THEN v_shrink
    WHEN 'expired'          THEN v_shrink
    WHEN 'defective'        THEN v_shrink
    WHEN 'obsolete'         THEN v_shrink
    WHEN 'quality_reject'   THEN v_shrink
    WHEN 'theft'            THEN v_shrink
    ELSE v_legacy
  END;
END;
$$;

-- 3. Segregation-of-duties trigger for scrap ---------------------------------
CREATE OR REPLACE FUNCTION public.sod_stock_adjustment_scrap_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.adjustment_type <> 'scrap' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('approved','posted')
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.approved_by IS NOT NULL
     AND NEW.created_by IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.organization_id,
      NEW.business_id,
      'scrap.approve',
      NEW.created_by,
      NEW.approved_by
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sod_stock_adjustment_scrap_guard ON public.stock_adjustments;
CREATE TRIGGER sod_stock_adjustment_scrap_guard
  BEFORE UPDATE ON public.stock_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.sod_stock_adjustment_scrap_guard();

INSERT INTO public.self_action_policy (organization_id, action_key, mode, applies_to_role)
SELECT o.id, 'scrap.approve', 'block', NULL
  FROM public.organizations o
 WHERE NOT EXISTS (
    SELECT 1 FROM public.self_action_policy p
     WHERE p.organization_id = o.id AND p.action_key = 'scrap.approve'
 );

-- 4. Rewrite record_scrap_atomic as a thin wrapper ---------------------------
CREATE OR REPLACE FUNCTION public.record_scrap_atomic(
  p_organization_id uuid,
  p_business_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_unit_cost numeric,
  p_reason text,
  p_notes text,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adj_id uuid;
  v_adj_number text;
  v_qty_abs numeric := abs(coalesce(p_quantity, 0));
  v_qty_before numeric;
  v_branch_id uuid;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'scrap');
  v_result jsonb;
BEGIN
  IF v_qty_abs <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap quantity must be positive');
  END IF;
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a business_id');
  END IF;

  v_adj_number := 'SCR-' || to_char(now(), 'YYYY') || '-'
    || lpad((coalesce((
        SELECT max(nullif(regexp_replace(adjustment_number, '^SCR-\d{4}-', ''), '')::int)
          FROM public.stock_adjustments
         WHERE organization_id = p_organization_id
           AND adjustment_number ~ ('^SCR-' || to_char(now(), 'YYYY') || '-\d+$')
      ), 0) + 1)::text, 5, '0');

  IF p_warehouse_id IS NOT NULL THEN
    SELECT branch_id INTO v_branch_id
      FROM public.warehouses
     WHERE id = p_warehouse_id;
  END IF;

  SELECT coalesce(quantity, 0) INTO v_qty_before
    FROM public.warehouse_stock
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id;
  v_qty_before := coalesce(v_qty_before, 0);

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, adjustment_type,
    reason, notes, status, created_by
  ) VALUES (
    p_organization_id, p_business_id, v_branch_id, p_warehouse_id,
    v_adj_number, now(), 'scrap',
    v_reason,
    coalesce(p_notes, ''),
    'draft', p_user_id
  ) RETURNING id INTO v_adj_id;

  INSERT INTO public.stock_adjustment_items (
    adjustment_id, product_id, warehouse_id, branch_id,
    quantity_before, quantity_adjustment, quantity_after,
    unit_cost, notes
  ) VALUES (
    v_adj_id, p_product_id, p_warehouse_id, v_branch_id,
    v_qty_before,
    -v_qty_abs,
    v_qty_before - v_qty_abs,
    nullif(p_unit_cost, 0),
    v_reason
  );

  v_result := public.approve_stock_adjustment_atomic(v_adj_id, p_user_id);

  IF coalesce((v_result->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', v_adj_id,
    'adjustment_number', v_adj_number,
    'movement_id', NULL,
    'gl_posted', coalesce((v_result->>'gl_posted')::boolean, false),
    'journal_entry_id', v_result->>'journal_entry_id'
  );
END;
$$;

COMMENT ON FUNCTION public.record_scrap_atomic IS
  'Thin wrapper: creates a stock_adjustments header with adjustment_type=scrap and posts it through approve_stock_adjustment_atomic. Do not add scrap-specific logic here.';
