-- Scrap lifecycle hardening: reason controls, account resolution, branchless warehouse fix

-- 1) Complete governance catalogue seed for posting.
INSERT INTO public.self_action_policy (organization_id, action_key, mode, applies_to_role)
SELECT o.id, 'scrap.post', 'block', NULL
  FROM public.organizations o
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.self_action_policy p
    WHERE p.organization_id = o.id
      AND p.action_key = 'scrap.post'
 );

-- Preserve solo-org operability, matching the prior scrap.approve fix.
DELETE FROM public.self_action_policy sap
 WHERE sap.action_key = 'scrap.post'
   AND sap.mode = 'block'
   AND sap.applies_to_role IS NULL
   AND (
     SELECT count(DISTINCT ur.user_id)
       FROM public.user_roles ur
      WHERE ur.organization_id = sap.organization_id
        AND ur.is_active = true
   ) <= 1;

-- 2) Resolve scrap reason offset-account purpose through the canonical default-account map.
CREATE OR REPLACE FUNCTION public.resolve_adjustment_offset_account(
  p_org_id uuid,
  p_business_id uuid,
  p_reason text,
  p_sign integer,
  p_branch_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_shrink uuid;
  v_over uuid;
  v_reval uuid;
  v_legacy uuid;
  v_obe uuid;
  v_reason text := lower(coalesce(p_reason,''));
  v_purpose text;
  v_account uuid;
BEGIN
  IF v_reason <> '' THEN
    SELECT sr.offset_account_purpose
      INTO v_purpose
      FROM public.scrap_reasons sr
     WHERE sr.organization_id = p_org_id
       AND sr.code = v_reason
       AND coalesce(sr.is_active, true) = true
     ORDER BY CASE WHEN sr.business_id IS NOT DISTINCT FROM p_business_id THEN 0 ELSE 1 END
     LIMIT 1;

    IF v_purpose IS NOT NULL AND length(trim(v_purpose)) > 0 THEN
      v_account := public._resolve_canonical_default_account(
        v_purpose,
        p_org_id,
        p_business_id,
        p_branch_id,
        now()
      );
      IF v_account IS NOT NULL THEN
        RETURN v_account;
      END IF;
    END IF;
  END IF;

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
    WHEN 'scrap'           THEN v_shrink
    WHEN 'scrap_damaged'   THEN v_shrink
    WHEN 'scrap_expired'   THEN v_shrink
    WHEN 'scrap_defective' THEN v_shrink
    WHEN 'scrap_obsolete'  THEN v_shrink
    WHEN 'scrap_quality'   THEN v_shrink
    WHEN 'scrap_theft'     THEN v_shrink
    WHEN 'scrap_other'     THEN v_shrink
    WHEN 'expired'         THEN v_shrink
    WHEN 'defective'       THEN v_shrink
    WHEN 'obsolete'        THEN v_shrink
    WHEN 'quality_reject'  THEN v_shrink
    WHEN 'theft'           THEN v_shrink
    ELSE v_legacy
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_adjustment_offset_account(uuid, uuid, text, integer, uuid)
  TO authenticated, service_role;

-- Keep the old 4-argument signature as a compatibility wrapper.
CREATE OR REPLACE FUNCTION public.resolve_adjustment_offset_account(
  p_org_id uuid,
  p_business_id uuid,
  p_reason text,
  p_sign integer
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.resolve_adjustment_offset_account($1, $2, $3, $4, NULL::uuid);
$$;

GRANT EXECUTE ON FUNCTION public.resolve_adjustment_offset_account(uuid, uuid, text, integer)
  TO authenticated, service_role;

-- 3) Enforce scrap reason controls immediately before the stock/GL engine transitions status.
CREATE OR REPLACE FUNCTION public.enforce_scrap_reason_controls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason public.scrap_reasons%ROWTYPE;
  v_total numeric := 0;
  v_attachment_count integer := 0;
  v_member_count integer := 0;
BEGIN
  IF NEW.adjustment_type IS DISTINCT FROM 'scrap' THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('approved','posted') OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_reason
    FROM public.scrap_reasons sr
   WHERE sr.organization_id = NEW.organization_id
     AND sr.code = NEW.reason
     AND coalesce(sr.is_active, true) = true
   ORDER BY CASE WHEN sr.business_id IS NOT DISTINCT FROM NEW.business_id THEN 0 ELSE 1 END
   LIMIT 1;

  SELECT COALESCE(SUM(ABS(quantity_adjustment) * COALESCE(unit_cost, 0)), 0)
    INTO v_total
    FROM public.stock_adjustment_items
   WHERE adjustment_id = NEW.id;

  IF FOUND AND COALESCE(v_reason.requires_attachment, false) THEN
    SELECT count(*) INTO v_attachment_count
      FROM public.scrap_attachments sa
     WHERE sa.scrap_id = NEW.id;

    IF v_attachment_count = 0 THEN
      RAISE EXCEPTION 'SCRAP_ATTACHMENT_REQUIRED: reason % requires a supporting attachment before posting', NEW.reason
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF FOUND AND COALESCE(v_reason.requires_approval_above, 0) > 0 AND v_total > v_reason.requires_approval_above THEN
    SELECT count(DISTINCT ur.user_id)
      INTO v_member_count
      FROM public.user_roles ur
     WHERE ur.organization_id = NEW.organization_id
       AND ur.is_active = true;

    IF v_member_count > 1 AND NEW.created_by IS NOT NULL AND NEW.approved_by IS NOT NULL AND NEW.created_by = NEW.approved_by THEN
      RAISE EXCEPTION 'SCRAP_APPROVAL_REQUIRED: scrap value % exceeds approval threshold % for reason %', v_total, v_reason.requires_approval_above, NEW.reason
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_scrap_reason_controls ON public.stock_adjustments;
CREATE TRIGGER enforce_scrap_reason_controls
  BEFORE UPDATE OF status ON public.stock_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_scrap_reason_controls();

-- 4) Update stock adjustment approval to pass branch-aware account resolution.
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(p_adjustment_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_adjustment RECORD;
  v_item RECORD;
  v_org_id UUID;
  v_biz_id UUID;
  v_branch_id UUID;
  v_adj_number text;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_offset_account UUID;
  v_reason text;
  v_journal_id UUID;
  v_entry_number text;
  v_resolved_cost numeric;
  v_cost_value numeric;
  v_total_value numeric := 0;
  v_locked_qty numeric;
  v_inv_debit numeric := 0;
  v_inv_credit numeric := 0;
  v_offset_rec RECORD;
  v_lines jsonb := '[]'::jsonb;
  v_is_lot_tracked boolean;
  v_allocs jsonb;
  v_qty_signed numeric;
  v_qty_abs numeric;
  v_alloc_sum numeric;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, reason, adjustment_number
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;
  IF v_adjustment.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment is already approved');
  END IF;
  IF v_adjustment.status NOT IN ('draft', 'pending_approval') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id := v_adjustment.organization_id;
  v_biz_id := v_adjustment.business_id;
  v_branch_id := v_adjustment.branch_id;
  v_reason := v_adjustment.reason;
  v_adj_number := v_adjustment.adjustment_number;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment has no business_id; cannot post to GL');
  END IF;

  SELECT inventory_account_id, adjustment_account_id
    INTO v_inventory_account_id, v_adjustment_account_id
    FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

  IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot approve stock adjustment: inventory or adjustment GL account not provisioned for company %', v_biz_id;
  END IF;

  PERFORM public.ensure_inventory_reason_gl_accounts(v_org_id, v_biz_id);

  CREATE TEMP TABLE IF NOT EXISTS _adj_offset_acc (
    offset_account_id uuid PRIMARY KEY,
    inv_debit numeric NOT NULL DEFAULT 0,
    inv_credit numeric NOT NULL DEFAULT 0,
    off_debit numeric NOT NULL DEFAULT 0,
    off_credit numeric NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  TRUNCATE TABLE _adj_offset_acc;

  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    SELECT quantity INTO v_locked_qty
      FROM public.warehouse_stock
     WHERE product_id = v_item.product_id
       AND warehouse_id = v_item.warehouse_id
     FOR UPDATE;

    IF v_item.quantity_adjustment = 0 THEN
      v_resolved_cost := 0;
    ELSE
      v_resolved_cost := public.resolve_adjustment_unit_cost(
        v_org_id, v_biz_id, v_item.product_id, v_item.warehouse_id, v_item.unit_cost
      );
      IF v_resolved_cost IS NULL OR v_resolved_cost <= 0 THEN
        RAISE EXCEPTION 'OPENING_STOCK_REQUIRES_COST: no valuation cost for product % (warehouse %). Provide a positive unit_cost on the adjustment line, or set the product cost first.', v_item.product_id, v_item.warehouse_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_item.unit_cost IS DISTINCT FROM v_resolved_cost THEN
        UPDATE public.stock_adjustment_items SET unit_cost = v_resolved_cost WHERE id = v_item.id;
      END IF;
    END IF;

    SELECT COALESCE(is_lot_tracked, false) INTO v_is_lot_tracked
      FROM public.products WHERE id = v_item.product_id;

    v_qty_signed := COALESCE(v_item.quantity_adjustment, 0);
    v_qty_abs := abs(v_qty_signed);

    IF v_qty_signed = 0 THEN
      NULL;
    ELSIF v_is_lot_tracked AND v_qty_signed < 0 THEN
      IF v_item.lot_allocations IS NOT NULL
         AND jsonb_typeof(v_item.lot_allocations) = 'array'
         AND jsonb_array_length(v_item.lot_allocations) > 0 THEN
        v_allocs := v_item.lot_allocations;
        SELECT COALESCE(SUM((e->>'qty')::numeric), 0) INTO v_alloc_sum
          FROM jsonb_array_elements(v_allocs) AS e;
        IF v_alloc_sum <> v_qty_abs THEN
          RAISE EXCEPTION 'lot_allocations sum (%) must equal abs(quantity_adjustment) (%) for product %', v_alloc_sum, v_qty_abs, v_item.product_id
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object('lot_number', r.lot_number, 'serial_number', r.serial_number, 'qty', r.qty)), '[]'::jsonb)
          INTO v_allocs
          FROM public.resolve_fefo_lots(v_biz_id, v_item.warehouse_id, v_item.product_id, v_qty_abs) r;
        UPDATE public.stock_adjustment_items
           SET lot_allocations = v_allocs
         WHERE id = v_item.id;
      END IF;

      PERFORM public.consume_lots_atomic(
        v_org_id, v_biz_id, v_item.warehouse_id, v_branch_id,
        v_item.product_id, 'adjustment_out',
        'stock_adjustment', p_adjustment_id, p_user_id,
        COALESCE(v_item.notes, 'Stock adjustment ' || COALESCE(v_adj_number,'')),
        v_allocs, v_resolved_cost
      );
    ELSIF v_is_lot_tracked AND v_qty_signed > 0 THEN
      IF v_item.lot_number IS NULL OR length(trim(v_item.lot_number)) = 0 THEN
        RAISE EXCEPTION 'Product % is lot-tracked; positive adjustment requires lot_number on the line', v_item.product_id
          USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, unit_cost, warehouse_id,
        reference_type, reference_id, notes, created_by,
        lot_number, serial_number
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_item.product_id, 'adjustment',
        v_qty_signed, v_resolved_cost, v_item.warehouse_id,
        'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id,
        v_item.lot_number, v_item.serial_number
      );
    ELSE
      INSERT INTO stock_movements (
        organization_id, business_id, branch_id, product_id, movement_type,
        quantity, unit_cost, warehouse_id,
        reference_type, reference_id, notes, created_by
      ) VALUES (
        v_org_id, v_biz_id, v_branch_id, v_item.product_id, 'adjustment',
        v_qty_signed, v_resolved_cost, v_item.warehouse_id,
        'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
      );
    END IF;

    v_cost_value := v_qty_abs * COALESCE(v_resolved_cost, 0);
    IF v_cost_value > 0 THEN
      v_offset_account := public.resolve_adjustment_offset_account(
        v_org_id, v_biz_id, v_reason, v_qty_signed, v_branch_id
      );
      IF v_offset_account IS NULL THEN
        RAISE EXCEPTION 'Cannot approve stock adjustment: no offset GL account resolved for reason %', v_reason;
      END IF;

      INSERT INTO _adj_offset_acc (offset_account_id, inv_debit, inv_credit, off_debit, off_credit)
      VALUES (
        v_offset_account,
        CASE WHEN v_qty_signed > 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_qty_signed < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_qty_signed < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_qty_signed > 0 THEN v_cost_value ELSE 0 END
      )
      ON CONFLICT (offset_account_id) DO UPDATE
        SET inv_debit = _adj_offset_acc.inv_debit + EXCLUDED.inv_debit,
            inv_credit = _adj_offset_acc.inv_credit + EXCLUDED.inv_credit,
            off_debit = _adj_offset_acc.off_debit + EXCLUDED.off_debit,
            off_credit = _adj_offset_acc.off_credit + EXCLUDED.off_credit;

      v_total_value := v_total_value + v_cost_value;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved', approved_by = p_user_id, approved_at = now()
   WHERE id = p_adjustment_id;

  IF v_total_value > 0 THEN
    FOR v_offset_rec IN SELECT * FROM _adj_offset_acc LOOP
      v_inv_debit := v_inv_debit + v_offset_rec.inv_debit;
      v_inv_credit := v_inv_credit + v_offset_rec.inv_credit;
      IF v_offset_rec.off_debit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit', v_offset_rec.off_debit,
          'credit', 0,
          'description', 'Stock adjustment offset'));
      END IF;
      IF v_offset_rec.off_credit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit', 0,
          'credit', v_offset_rec.off_credit,
          'description', 'Stock adjustment offset'));
      END IF;
    END LOOP;

    IF v_inv_debit > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory_account_id,
        'debit', v_inv_debit,
        'credit', 0,
        'description', 'Inventory'));
    END IF;
    IF v_inv_credit > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory_account_id,
        'debit', 0,
        'credit', v_inv_credit,
        'description', 'Inventory'));
    END IF;

    v_entry_number := public.get_next_journal_entry_number(v_org_id);

    v_journal_id := public.post_journal_entry_atomic(
      _org_id := v_org_id,
      _business_id := v_biz_id,
      _entry_number := v_entry_number,
      _entry_date := CURRENT_DATE,
      _reference := COALESCE(v_adj_number, 'ADJ-' || LEFT(p_adjustment_id::text, 8)),
      _description := 'Stock adjustment ' || COALESCE(v_adj_number, 'ADJ-' || LEFT(p_adjustment_id::text, 8)) || ' (' || COALESCE(v_reason, 'unspecified') || ')',
      _source_type := 'stock_adjustment',
      _source_id := p_adjustment_id,
      _created_by := p_user_id,
      _is_closing := false,
      _is_adjusting := false,
      _lines := v_lines,
      _branch_id := v_branch_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'gl_posted', v_journal_id IS NOT NULL,
    'journal_entry_id', v_journal_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_stock_adjustment_atomic(uuid, uuid) TO authenticated, service_role;

-- 5) Fix record_scrap_atomic so a valid branchless warehouse is not rejected.
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
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_adj_id uuid;
  v_adj_number text;
  v_qty_abs numeric := abs(coalesce(p_quantity, 0));
  v_qty_before numeric;
  v_branch_id uuid;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'scrap');
  v_result jsonb;
  v_warehouse_found boolean := false;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires an organization');
  END IF;

  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a signed-in user');
  END IF;

  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a company');
  END IF;

  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a product');
  END IF;

  IF p_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap requires a warehouse');
  END IF;

  IF v_qty_abs <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Scrap quantity must be positive');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.products p
     WHERE p.id = p_product_id
       AND p.organization_id = p_organization_id
       AND p.business_id = p_business_id
       AND p.type = 'product'
       AND COALESCE(p.is_active, true) = true
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Selected product is not an active inventory product for this company');
  END IF;

  SELECT w.branch_id, true
    INTO v_branch_id, v_warehouse_found
    FROM public.warehouses w
   WHERE w.id = p_warehouse_id
     AND w.organization_id = p_organization_id
     AND w.business_id = p_business_id
     AND COALESCE(w.is_active, true) = true;

  IF NOT COALESCE(v_warehouse_found, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Selected warehouse is not active for this company');
  END IF;

  SELECT COALESCE(sr.code, v_reason)
    INTO v_reason
    FROM public.scrap_reasons sr
   WHERE sr.organization_id = p_organization_id
     AND sr.code = v_reason
     AND coalesce(sr.is_active, true) = true
   ORDER BY CASE WHEN sr.business_id IS NOT DISTINCT FROM p_business_id THEN 0 ELSE 1 END
   LIMIT 1;
  v_reason := coalesce(v_reason, coalesce(nullif(trim(p_reason), ''), 'scrap'));

  v_adj_number := 'SCR-' || to_char(now(), 'YYYY') || '-'
    || lpad((coalesce((
        SELECT max(nullif(regexp_replace(adjustment_number, '^SCR-\d{4}-', ''), '')::int)
          FROM public.stock_adjustments
         WHERE organization_id = p_organization_id
           AND adjustment_number ~ ('^SCR-' || to_char(now(), 'YYYY') || '-\d+$')
      ), 0) + 1)::text, 5, '0');

  SELECT coalesce(quantity, 0)
    INTO v_qty_before
    FROM public.warehouse_stock
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id
     AND business_id = p_business_id;
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

GRANT EXECUTE ON FUNCTION public.record_scrap_atomic(uuid, uuid, uuid, uuid, numeric, numeric, text, text, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.record_scrap_atomic(uuid, uuid, uuid, uuid, numeric, numeric, text, text, uuid) IS
  'Creates a scrap stock_adjustment document and posts it through approve_stock_adjustment_atomic after validating company, product, warehouse, and scrap reason controls.';